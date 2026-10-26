import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { recordAudit } from "@/modules/audit";
import { applyReceivedCost, listShopProductsForStock, loadProductNames, loadProductsForStock, lockProductsForStock, type ProductStockUnits } from "@/modules/catalog";
import { hasPermission, loadUserNames, requirePermission, type SessionContext } from "@/modules/identity";
import { appendStockMovement, lockStockRows, stockOnHand } from "@/modules/inventory";
import { appendLedgerEntry, lockPartyBalance, partyBalance, partyBalancesFor, partyStatement } from "@/modules/ledger";
import { findSupplier, insertSupplier, listShopSuppliers, supplierNameTaken, updateSupplierRow } from "@/modules/parties";
import { recordSupplierPayment, reverseSupplierPaymentRow, supplierPayments } from "@/modules/payments";
import { getCurrentShop, takeDocumentNumber } from "@/modules/settings";
import { withIdempotency } from "@/modules/sync";
import { getDb, withTransaction, type Database, type Transaction } from "@/server/db";
import { lockDayForWrite } from "@/server/day-lock";
import { isUniqueViolation } from "@/server/db-errors";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import { financialYearLabel, indiaDate } from "@/shared/financial-year";
import { formatPaise } from "@/shared/money";
import { computePurchaseTotals, costPerBaseUnit, weightedAverageCost } from "@/shared/purchase";
import { formatQuantity, isWholeQuantity, ONE_UNIT, parseQuantity, toBaseQuantity, toDbQuantity, type Milli } from "@/shared/quantity";
import { PURCHASES_CANCEL, PURCHASES_EDIT, PURCHASES_VIEW, STOCK_RECEIVE, SUPPLIERS_PAY } from "./permissions";
import { goodsReceiptLines, goodsReceipts, purchaseOrderLines, purchaseOrders } from "./schema";
import { purchaseOrderInputSchema, reasonSchema, receiptInputSchema, supplierInputSchema, supplierPaymentInputSchema } from "./validation";

/**
 * Supplier purchases (spec §5, scenarios S1, S2, S5). A purchase order records what was ordered;
 * a goods receipt records what arrived and is the only thing that moves stock and money:
 *   PURCHASE stock movement per line · cost price by weighted average (handoff §2.2) · supplier
 *   ledger credit for the bill total (the shop owes more) · audit — all in one transaction.
 * Supplier payments debit the supplier ledger. Mistakes are reversed, never edited: a cancelled
 * receipt takes the stock back out and debits the ledger; a reversed payment gets a matching row.
 *
 * Supplier balance owed = −SUM(debit − credit) on the supplier's ledger.
 * Lock order: document (order / receipt) → products → stock_levels → party_balances → number_series.
 */

const actorOf = (session: SessionContext) => ({ shopId: session.shopId, userId: session.userId, role: session.role });
type Db = Database | Transaction;
const owedFrom = (ledgerBalance: number) => (ledgerBalance === 0 ? 0 : -ledgerBalance);

// ── Suppliers ────────────────────────────────────────────────────────────────

export async function listSuppliers(session: SessionContext, options: { includeInactive?: boolean } = {}) {
  await requirePermission(session, PURCHASES_VIEW);
  const suppliers = await listShopSuppliers(session.shopId, options);
  const balances = await partyBalancesFor(session.shopId, "supplier", suppliers.map((supplier) => supplier.id));
  return suppliers.map((supplier) => ({ ...supplier, owedPaise: owedFrom(balances.get(supplier.id) ?? 0) }));
}

export async function createSupplier(session: SessionContext, input: unknown): Promise<{ id: string }> {
  await requirePermission(session, PURCHASES_EDIT);
  const data = supplierInputSchema.parse(input);
  return withTransaction(async (tx) => {
    if (await supplierNameTaken(tx, session.shopId, data.name)) throw new ConflictError("SUPPLIER_EXISTS", `There is already a supplier called "${data.name}".`, { fieldErrors: { name: "Name already used." } });
    const id = await insertSupplier(tx, session.shopId, data);
    await recordAudit(tx, actorOf(session), { action: "purchasing.supplier_added", entityType: "supplier", entityId: id, after: data });
    return { id };
  });
}

export async function updateSupplier(session: SessionContext, supplierId: string, input: unknown): Promise<void> {
  await requirePermission(session, PURCHASES_EDIT);
  const data = supplierInputSchema.parse(input);
  await withTransaction(async (tx) => {
    const before = await findSupplier(session.shopId, supplierId, tx);
    if (await supplierNameTaken(tx, session.shopId, data.name, before.id)) throw new ConflictError("SUPPLIER_EXISTS", `There is already a supplier called "${data.name}".`, { fieldErrors: { name: "Name already used." } });
    await updateSupplierRow(tx, session.shopId, before.id, data);
    await recordAudit(tx, actorOf(session), {
      action: "purchasing.supplier_updated",
      entityType: "supplier",
      entityId: before.id,
      before: { name: before.name, phone: before.phone, gstin: before.gstin, paymentTermsDays: before.paymentTermsDays },
      after: data,
    });
  });
}

export async function setSupplierActive(session: SessionContext, supplierId: string, active: boolean): Promise<void> {
  await requirePermission(session, PURCHASES_EDIT);
  await withTransaction(async (tx) => {
    const supplier = await findSupplier(session.shopId, supplierId, tx);
    if (supplier.isActive === active) return;
    await updateSupplierRow(tx, session.shopId, supplier.id, { isActive: active });
    await recordAudit(tx, actorOf(session), { action: active ? "purchasing.supplier_activated" : "purchasing.supplier_deactivated", entityType: "supplier", entityId: supplier.id, before: { isActive: supplier.isActive }, after: { isActive: active } });
  });
}

export async function getSupplier(session: SessionContext, supplierId: string) {
  await requirePermission(session, PURCHASES_VIEW);
  const db = getDb();
  const supplier = await findSupplier(session.shopId, supplierId);
  const [statement, payments, receipts, orders, canPay, canEdit] = await Promise.all([
    partyStatement(session.shopId, "supplier", supplier.id),
    supplierPayments(db, session.shopId, supplier.id),
    db
      .select({ id: goodsReceipts.id, number: goodsReceipts.number, receivedDate: goodsReceipts.receivedDate, supplierBillNo: goodsReceipts.supplierBillNo, totalPaise: goodsReceipts.totalPaise, status: goodsReceipts.status })
      .from(goodsReceipts)
      .where(and(eq(goodsReceipts.shopId, session.shopId), eq(goodsReceipts.supplierId, supplier.id)))
      .orderBy(desc(goodsReceipts.createdAt)),
    db
      .select({ id: purchaseOrders.id, number: purchaseOrders.number, orderDate: purchaseOrders.orderDate, status: purchaseOrders.status })
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.shopId, session.shopId), eq(purchaseOrders.supplierId, supplier.id)))
      .orderBy(desc(purchaseOrders.createdAt)),
    hasPermission(session, SUPPLIERS_PAY),
    hasPermission(session, PURCHASES_EDIT),
  ]);
  const owedPaise = owedFrom(statement.at(-1)?.balancePaise ?? 0);
  return {
    ...supplier,
    owedPaise,
    // Owed by the shop, shown as positive amounts: a purchase raises it, a payment lowers it.
    statement: statement.map((line) => ({ ...line, owedAfterPaise: owedFrom(line.balancePaise) })),
    payments,
    receipts,
    orders,
    canPay,
    canEdit,
  };
}

// ── Purchase orders ──────────────────────────────────────────────────────────

function factorFor(product: ProductStockUnits, unit: string): Milli | null {
  return unit === product.baseUnit ? ONE_UNIT : (product.saleUnits.find((candidate) => candidate.code === unit)?.factor ?? null);
}

function baseQuantity(product: ProductStockUnits, unit: string, quantity: Milli, field: string): { factor: Milli; base: Milli } {
  const factor = factorFor(product, unit);
  if (!factor) throw new ValidationError(`${product.name} isn't bought in "${unit}".`, { fieldErrors: { [field]: "Choose one of this product's units." } });
  const base = toBaseQuantity(quantity, factor);
  if (base === null) throw new ValidationError("That quantity can't be stored exactly. Use fewer decimal places.", { fieldErrors: { [field]: "Use fewer decimal places." } });
  if (!product.baseAllowsDecimal && !isWholeQuantity(base)) {
    throw new ValidationError(`${product.baseUnitName} can't be split: ${product.name} must come to a whole number of ${product.baseUnit}.`, { fieldErrors: { [field]: "Whole numbers only." } });
  }
  return { factor, base };
}

export async function createPurchaseOrder(session: SessionContext, input: unknown): Promise<{ id: string; number: string; replayed: boolean }> {
  await requirePermission(session, PURCHASES_EDIT);
  const { idempotencyKey, ...data } = purchaseOrderInputSchema.parse(input);
  return withTransaction(async (tx) => {
    const outcome = await withIdempotency<{ id: string; number: string }>(tx, { shopId: session.shopId, userId: session.userId, key: idempotencyKey }, { action: "purchasing.order", ...data, lines: data.lines.map((line) => ({ ...line, quantity: line.quantity.toString() })) }, async () => {
      const supplier = await findSupplier(session.shopId, data.supplierId, tx);
      if (!supplier.isActive) throw new ConflictError("SUPPLIER_INACTIVE", `${supplier.name} is switched off.`);
      const products = new Map((await loadProductsForStock(session.shopId, data.lines.map((line) => line.productId), tx)).map((product) => [product.id, product]));
      const lines = data.lines.map((line, index) => {
        const product = products.get(line.productId);
        if (!product) throw new ValidationError("Product not found.", { fieldErrors: { [`lines.${index}.productId`]: "Product not found." } });
        if (!product.isActive) throw new ValidationError(`${product.name} is switched off.`, { fieldErrors: { [`lines.${index}.productId`]: "Switched off." } });
        const { factor } = baseQuantity(product, line.unit, line.quantity, `lines.${index}.quantity`);
        return { productId: product.id, unit: line.unit, factor: toDbQuantity(factor), qtyOrdered: toDbQuantity(line.quantity), costPaisePerUnit: line.cost };
      });
      const { fy, number } = await takeDocumentNumber(tx, session.shopId, "PO");
      const [order] = await tx.insert(purchaseOrders).values({ shopId: session.shopId, fy, number, supplierId: supplier.id, orderDate: indiaDate(), status: "ordered", createdBy: session.userId }).returning({ id: purchaseOrders.id });
      await tx.insert(purchaseOrderLines).values(lines.map((line) => ({ ...line, purchaseOrderId: order!.id })));
      await recordAudit(tx, actorOf(session), { action: "purchasing.order_created", entityType: "purchase_order", entityId: order!.id, after: { number, supplierId: supplier.id, lines: lines.length } });
      return { status: 201, body: { id: order!.id, number } };
    });
    return { ...outcome.body, replayed: outcome.replayed };
  });
}

/** Received base quantity per order line, counting only receipts that are not cancelled. */
async function receivedByLine(db: Db, lineIds: string[]): Promise<Map<string, Milli>> {
  if (lineIds.length === 0) return new Map();
  const rows = await db
    .select({ lineId: goodsReceiptLines.purchaseOrderLineId, qty: sql<string>`sum(${goodsReceiptLines.qtyBase})::text` })
    .from(goodsReceiptLines)
    .innerJoin(goodsReceipts, eq(goodsReceipts.id, goodsReceiptLines.goodsReceiptId))
    .where(and(inArray(goodsReceiptLines.purchaseOrderLineId, lineIds), ne(goodsReceipts.status, "cancelled")))
    .groupBy(goodsReceiptLines.purchaseOrderLineId);
  return new Map(rows.map((row) => [row.lineId!, parseQuantity(row.qty)]));
}

async function orderStatusAfter(tx: Transaction, orderId: string): Promise<"ordered" | "partially_received" | "received"> {
  const lines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, orderId));
  const received = await receivedByLine(tx, lines.map((line) => line.id));
  const ordered = lines.map((line) => ({ ordered: toBaseQuantity(parseQuantity(line.qtyOrdered), parseQuantity(line.factor)) ?? BigInt(0), received: received.get(line.id) ?? BigInt(0) }));
  if (ordered.every((line) => line.received === BigInt(0))) return "ordered";
  return ordered.every((line) => line.received >= line.ordered) ? "received" : "partially_received";
}

async function lockOrder(tx: Transaction, shopId: string, orderId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) throw new NotFoundError("Purchase order not found.");
  const [order] = await tx.select().from(purchaseOrders).where(and(eq(purchaseOrders.id, orderId), eq(purchaseOrders.shopId, shopId))).limit(1).for("update");
  if (!order) throw new NotFoundError("Purchase order not found.");
  return order;
}

export async function cancelPurchaseOrder(session: SessionContext, orderId: string, input: unknown): Promise<void> {
  await requirePermission(session, PURCHASES_CANCEL);
  const { reason } = reasonSchema.parse(input);
  await withTransaction(async (tx) => {
    const order = await lockOrder(tx, session.shopId, orderId);
    if (order.status !== "ordered") throw new ConflictError("ORDER_HAS_RECEIPTS", order.status === "cancelled" ? "This order is already cancelled." : "Goods were already received on this order. Close the shortfall instead, or cancel the receipts first.");
    await tx.update(purchaseOrders).set({ status: "cancelled" }).where(eq(purchaseOrders.id, order.id));
    await recordAudit(tx, actorOf(session), { action: "purchasing.order_cancelled", entityType: "purchase_order", entityId: order.id, before: { status: order.status }, after: { status: "cancelled" }, reason });
  });
}

/** Spec S2: the owner closes a short delivery so nothing more is expected. */
export async function closePurchaseOrder(session: SessionContext, orderId: string, input: unknown): Promise<void> {
  await requirePermission(session, PURCHASES_CANCEL);
  const { reason } = reasonSchema.parse(input);
  await withTransaction(async (tx) => {
    const order = await lockOrder(tx, session.shopId, orderId);
    if (order.status !== "partially_received") throw new ConflictError("NOT_SHORT", "Only an order received short can be closed.");
    await tx.update(purchaseOrders).set({ status: "closed" }).where(eq(purchaseOrders.id, order.id));
    await recordAudit(tx, actorOf(session), { action: "purchasing.order_closed", entityType: "purchase_order", entityId: order.id, before: { status: order.status }, after: { status: "closed" }, reason });
  });
}

// ── Goods receipts ───────────────────────────────────────────────────────────

export type CreatedReceipt = { id: string; number: string; totalPaise: number; replayed: boolean };

export async function receiveGoods(session: SessionContext, input: unknown): Promise<CreatedReceipt> {
  await requirePermission(session, STOCK_RECEIVE);
  const { idempotencyKey, ...data } = receiptInputSchema.parse(input);
  const body = { action: "purchasing.receipt", ...data, lines: data.lines.map((line) => ({ ...line, quantity: line.quantity.toString() })) };

  try {
    return await withTransaction(async (tx) => {
      const outcome = await withIdempotency<Omit<CreatedReceipt, "replayed">>(tx, { shopId: session.shopId, userId: session.userId, key: idempotencyKey }, body, async () => {
        await lockDayForWrite(tx, session.shopId, indiaDate());
        // 1. Document: the order (if any) decides supplier, products, units and what is left to receive.
        const order = data.purchaseOrderId ? await lockOrder(tx, session.shopId, data.purchaseOrderId) : null;
        if (order && order.status !== "ordered" && order.status !== "partially_received") {
          throw new ConflictError("ORDER_NOT_OPEN", `This order is ${order.status === "cancelled" ? "cancelled" : order.status === "closed" ? "closed" : "fully received"}, so nothing more can be received on it.`);
        }
        const supplier = await findSupplier(session.shopId, order?.supplierId ?? data.supplierId!, tx);
        if (!supplier.isActive) throw new ConflictError("SUPPLIER_INACTIVE", `${supplier.name} is switched off.`);
        const orderLines = order ? new Map((await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, order.id))).map((line) => [line.id, line])) : new Map<string, typeof purchaseOrderLines.$inferSelect>();
        const alreadyReceived = order ? await receivedByLine(tx, [...orderLines.keys()]) : new Map<string, Milli>();

        const requested = data.lines.map((line, index) => {
          if (order) {
            const orderLine = line.purchaseOrderLineId ? orderLines.get(line.purchaseOrderLineId) : undefined;
            if (!orderLine) throw new ValidationError("That item is not on this order.", { fieldErrors: { [`lines.${index}.productId`]: "Not on this order." } });
            return { index, orderLine, productId: orderLine.productId, unit: orderLine.unit, quantity: line.quantity, cost: line.cost, gstRateBp: line.gstRateBp };
          }
          if (!line.productId || !line.unit) throw new ValidationError("Choose a product and unit.", { fieldErrors: { [`lines.${index}.productId`]: "Choose a product." } });
          return { index, orderLine: null, productId: line.productId, unit: line.unit, quantity: line.quantity, cost: line.cost, gstRateBp: line.gstRateBp };
        });

        // 2. Products (locked, id order) and 3. their stock rows.
        const products = new Map((await lockProductsForStock(tx, session.shopId, requested.map((line) => line.productId))).map((product) => [product.id, product]));
        await lockStockRows(tx, session.shopId, requested.map((line) => line.productId));
        const planned = requested.map((line) => {
          const product = products.get(line.productId);
          if (!product) throw new ValidationError("Product not found.", { fieldErrors: { [`lines.${line.index}.productId`]: "Product not found." } });
          if (!line.orderLine && !product.isActive) throw new ValidationError(`${product.name} is switched off.`, { fieldErrors: { [`lines.${line.index}.productId`]: "Switched off." } });
          const { factor, base } = baseQuantity(product, line.unit, line.quantity, `lines.${line.index}.quantity`);
          if (line.orderLine) {
            const ordered = toBaseQuantity(parseQuantity(line.orderLine.qtyOrdered), parseQuantity(line.orderLine.factor)) ?? BigInt(0);
            const left = ordered - (alreadyReceived.get(line.orderLine.id) ?? BigInt(0));
            if (base > left) {
              throw new ConflictError("OVER_RECEIPT", `Only ${formatQuantity(left > BigInt(0) ? left : BigInt(0))} ${product.baseUnit} of ${product.name} are still expected on this order.`, {
                fieldErrors: { [`lines.${line.index}.quantity`]: `At most ${formatQuantity(left > BigInt(0) ? left : BigInt(0))} ${product.baseUnit}.` },
              });
            }
          }
          return { ...line, product, factor, base };
        });

        const totals = computePurchaseTotals(planned.map((line) => ({ quantity: line.quantity, costPaisePerUnit: line.cost, gstRateBp: line.gstRateBp })));
        const stock = await stockOnHand(session.shopId, planned.map((line) => line.product.id), tx);

        // 4. Supplier balance, then 5. the receipt number.
        await lockPartyBalance(tx, session.shopId, "supplier", supplier.id);
        const { fy, number } = await takeDocumentNumber(tx, session.shopId, "GRN");
        const today = indiaDate();
        const [receipt] = await tx
          .insert(goodsReceipts)
          .values({ shopId: session.shopId, fy, number, purchaseOrderId: order?.id ?? null, supplierId: supplier.id, supplierBillNo: data.supplierBillNo, supplierBillDate: data.supplierBillDate, receivedDate: today, taxablePaise: totals.taxablePaise, gstPaise: totals.gstPaise, totalPaise: totals.totalPaise, createdBy: session.userId })
          .returning({ id: goodsReceipts.id });
        const receiptId = receipt!.id;
        const costChanges: { productId: string; from: number | null; to: number }[] = [];
        for (const [position, line] of planned.entries()) {
          const value = totals.lines[position]!.valuePaise;
          const perBase = costPerBaseUnit(value, line.base);
          await tx.insert(goodsReceiptLines).values({
            goodsReceiptId: receiptId,
            purchaseOrderLineId: line.orderLine?.id ?? null,
            productId: line.product.id,
            unit: line.unit,
            factor: toDbQuantity(line.factor),
            qty: toDbQuantity(line.quantity),
            costPaisePerUnit: line.cost,
            qtyBase: toDbQuantity(line.base),
            unitCostPaise: perBase,
            linePaise: value,
            gstRateBp: line.gstRateBp,
            gstPaise: totals.lines[position]!.gstPaise,
          });
          const onHand = stock.get(line.product.id)?.qty ?? BigInt(0);
          const newCost = weightedAverageCost(onHand, line.product.costPaise, line.base, value);
          await appendStockMovement(tx, { shopId: session.shopId, productId: line.product.id, movementDate: today, kind: "purchase", qtyBase: line.base, unitCostPaise: perBase, sourceType: "goods_receipt", sourceId: receiptId, reason: number, createdBy: session.userId });
          if (newCost !== line.product.costPaise) {
            await applyReceivedCost(tx, session.shopId, line.product.id, newCost, receiptId);
            costChanges.push({ productId: line.product.id, from: line.product.costPaise, to: newCost });
          }
        }
        await appendLedgerEntry(tx, { shopId: session.shopId, partyType: "supplier", partyId: supplier.id, entryDate: today, kind: "purchase", sourceType: "goods_receipt", sourceId: receiptId, creditPaise: totals.totalPaise });
        if (order) await tx.update(purchaseOrders).set({ status: await orderStatusAfter(tx, order.id) }).where(eq(purchaseOrders.id, order.id));
        await recordAudit(tx, actorOf(session), {
          action: "purchasing.goods_received",
          entityType: "goods_receipt",
          entityId: receiptId,
          after: { number, supplierId: supplier.id, purchaseOrderId: order?.id ?? null, supplierBillNo: data.supplierBillNo, totalPaise: totals.totalPaise, gstPaise: totals.gstPaise, lines: planned.length, costChanges },
        });
        return { status: 201, body: { id: receiptId, number, totalPaise: totals.totalPaise } };
      });
      return { ...outcome.body, replayed: outcome.replayed };
    });
  } catch (error) {
    if (isUniqueViolation(error, "goods_receipts_supplier_bill_active_key")) {
      throw new ConflictError("DUPLICATE_SUPPLIER_BILL", `Bill ${data.supplierBillNo} from this supplier is already entered.`, { fieldErrors: { supplierBillNo: "Already entered for this supplier." } });
    }
    throw error;
  }
}

/**
 * Cancels a goods receipt entered by mistake (owner): PURCHASE movements of the same quantity with a
 * minus sign take the stock back out, the supplier ledger is debited by the bill total, and the
 * receipt is marked cancelled. Refused if the goods were already sold or used (stock too low).
 * The product's cost price is left as it is: a weighted average can't be undone exactly.
 */
export async function cancelGoodsReceipt(session: SessionContext, receiptId: string, input: unknown): Promise<void> {
  await requirePermission(session, PURCHASES_CANCEL);
  const { reason } = reasonSchema.parse(input);
  if (!/^[0-9a-f-]{36}$/i.test(receiptId)) throw new NotFoundError("Receipt not found.");
  await withTransaction(async (tx) => {
    await lockDayForWrite(tx, session.shopId, indiaDate());
    const [receipt] = await tx.select().from(goodsReceipts).where(and(eq(goodsReceipts.id, receiptId), eq(goodsReceipts.shopId, session.shopId))).limit(1).for("update");
    if (!receipt) throw new NotFoundError("Receipt not found.");
    if (receipt.status === "cancelled") throw new ConflictError("ALREADY_CANCELLED", "This receipt is already cancelled.");
    if (receipt.purchaseOrderId) await lockOrder(tx, session.shopId, receipt.purchaseOrderId);
    const lines = await tx.select().from(goodsReceiptLines).where(eq(goodsReceiptLines.goodsReceiptId, receipt.id));
    const productIds = lines.map((line) => line.productId);
    const products = new Map((await lockProductsForStock(tx, session.shopId, productIds)).map((product) => [product.id, product]));
    await lockStockRows(tx, session.shopId, productIds);
    const stock = await stockOnHand(session.shopId, productIds, tx);
    for (const line of lines) {
      const need = parseQuantity(line.qtyBase);
      const have = stock.get(line.productId)?.qty ?? BigInt(0);
      if (have < need) {
        const product = products.get(line.productId);
        throw new ConflictError("STOCK_ALREADY_USED", `Only ${formatQuantity(have)} ${product?.baseUnit ?? ""} of ${product?.name ?? "a product"} are left, less than this receipt brought in. Record a stock adjustment instead.`);
      }
    }
    await lockPartyBalance(tx, session.shopId, "supplier", receipt.supplierId);
    const today = indiaDate();
    await tx.update(goodsReceipts).set({ status: "cancelled", cancelledAt: new Date(), cancelledBy: session.userId, cancelReason: reason }).where(eq(goodsReceipts.id, receipt.id));
    for (const line of lines) {
      await appendStockMovement(tx, { shopId: session.shopId, productId: line.productId, movementDate: today, kind: "purchase", qtyBase: -parseQuantity(line.qtyBase), unitCostPaise: line.unitCostPaise, sourceType: "goods_receipt_cancel", sourceId: receipt.id, reason: `Cancelled ${receipt.number}: ${reason}`, createdBy: session.userId });
    }
    await appendLedgerEntry(tx, { shopId: session.shopId, partyType: "supplier", partyId: receipt.supplierId, entryDate: today, kind: "cancellation", sourceType: "goods_receipt", sourceId: receipt.id, debitPaise: receipt.totalPaise });
    if (receipt.purchaseOrderId) {
      const [order] = await tx.select({ status: purchaseOrders.status }).from(purchaseOrders).where(eq(purchaseOrders.id, receipt.purchaseOrderId));
      if (order && order.status !== "closed" && order.status !== "cancelled") await tx.update(purchaseOrders).set({ status: await orderStatusAfter(tx, receipt.purchaseOrderId) }).where(eq(purchaseOrders.id, receipt.purchaseOrderId));
    }
    await recordAudit(tx, actorOf(session), { action: "purchasing.receipt_cancelled", entityType: "goods_receipt", entityId: receipt.id, before: { status: receipt.status }, after: { status: "cancelled", number: receipt.number, totalPaise: receipt.totalPaise }, reason });
  });
}

// ── Supplier payments ────────────────────────────────────────────────────────

export async function paySupplier(session: SessionContext, input: unknown): Promise<{ id: string; owedAfterPaise: number; replayed: boolean }> {
  await requirePermission(session, SUPPLIERS_PAY);
  const { idempotencyKey, ...data } = supplierPaymentInputSchema.parse(input);
  try {
    return await withTransaction(async (tx) => {
      const outcome = await withIdempotency<{ id: string; owedAfterPaise: number }>(tx, { shopId: session.shopId, userId: session.userId, key: idempotencyKey }, { action: "purchasing.supplier_payment", ...data }, async () => {
        await lockDayForWrite(tx, session.shopId, indiaDate());
        const supplier = await findSupplier(session.shopId, data.supplierId, tx);
        await lockPartyBalance(tx, session.shopId, "supplier", supplier.id);
        const owed = owedFrom(await partyBalance(session.shopId, "supplier", supplier.id, tx));
        if (data.amount > owed) {
          throw new ConflictError("OVERPAYMENT", owed > 0 ? `You owe ${supplier.name} ${formatPaise(owed, { withPaise: true })}; you can't pay more than that.` : `You don't owe ${supplier.name} anything right now.`, { fieldErrors: { amount: `At most ${formatPaise(Math.max(owed, 0), { withPaise: true })}.` } });
        }
        const today = indiaDate();
        const paymentId = await recordSupplierPayment(tx, { shopId: session.shopId, fy: financialYearLabel(), supplierId: supplier.id, method: data.method, amountPaise: data.amount, reference: data.method === "cash" ? null : data.reference, businessDate: today, recordedBy: session.userId });
        await appendLedgerEntry(tx, { shopId: session.shopId, partyType: "supplier", partyId: supplier.id, entryDate: today, kind: "payment", sourceType: "payment", sourceId: paymentId, debitPaise: data.amount });
        await recordAudit(tx, actorOf(session), { action: "purchasing.supplier_paid", entityType: "payment", entityId: paymentId, after: { supplierId: supplier.id, amountPaise: data.amount, method: data.method, reference: data.reference, owedBeforePaise: owed } });
        return { status: 201, body: { id: paymentId, owedAfterPaise: owed - data.amount } };
      });
      return { ...outcome.body, replayed: outcome.replayed };
    });
  } catch (error) {
    if (isUniqueViolation(error, "payments_no_duplicate_ref")) throw new ConflictError("DUPLICATE_REFERENCE", `A ${data.method.toUpperCase()} payment with reference ${data.reference} is already recorded.`, { fieldErrors: { reference: "Already used." } });
    throw error;
  }
}

/** Reverses a supplier payment entered by mistake (owner, reason required). */
export async function reverseSupplierPayment(session: SessionContext, paymentId: string, input: unknown): Promise<void> {
  await requirePermission(session, SUPPLIERS_PAY);
  const { reason } = reasonSchema.parse(input);
  await withTransaction(async (tx) => {
    const today = indiaDate();
    await lockDayForWrite(tx, session.shopId, indiaDate());
    const result = await reverseSupplierPaymentRow(tx, session.shopId, paymentId, { fy: financialYearLabel(), businessDate: today, recordedBy: session.userId });
    if (!result) throw new NotFoundError("Payment not found.");
    if (!result.reversalId) throw new ConflictError("ALREADY_REVERSED", "This payment is already reversed.");
    const supplierId = result.original.partyId!;
    await lockPartyBalance(tx, session.shopId, "supplier", supplierId);
    await appendLedgerEntry(tx, { shopId: session.shopId, partyType: "supplier", partyId: supplierId, entryDate: today, kind: "payment", sourceType: "payment", sourceId: result.reversalId, creditPaise: result.original.amountPaise });
    await recordAudit(tx, actorOf(session), { action: "purchasing.supplier_payment_reversed", entityType: "payment", entityId: result.original.id, before: { status: "recorded" }, after: { status: "reversed", reversalId: result.reversalId, amountPaise: result.original.amountPaise }, reason });
  });
}

// ── Reading ──────────────────────────────────────────────────────────────────

export async function listPurchaseOrders(session: SessionContext) {
  await requirePermission(session, PURCHASES_VIEW);
  const rows = await getDb()
    .select({ id: purchaseOrders.id, number: purchaseOrders.number, orderDate: purchaseOrders.orderDate, status: purchaseOrders.status, supplierId: purchaseOrders.supplierId })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.shopId, session.shopId))
    .orderBy(desc(purchaseOrders.createdAt))
    .limit(100);
  const suppliers = new Map((await listShopSuppliers(session.shopId, { includeInactive: true })).map((supplier) => [supplier.id, supplier.name]));
  return rows.map((row) => ({ ...row, supplierName: suppliers.get(row.supplierId) ?? "Supplier" }));
}

export async function listGoodsReceipts(session: SessionContext) {
  await requirePermission(session, PURCHASES_VIEW);
  const rows = await getDb()
    .select({ id: goodsReceipts.id, number: goodsReceipts.number, receivedDate: goodsReceipts.receivedDate, supplierId: goodsReceipts.supplierId, supplierBillNo: goodsReceipts.supplierBillNo, totalPaise: goodsReceipts.totalPaise, status: goodsReceipts.status, purchaseOrderId: goodsReceipts.purchaseOrderId })
    .from(goodsReceipts)
    .where(eq(goodsReceipts.shopId, session.shopId))
    .orderBy(desc(goodsReceipts.createdAt))
    .limit(100);
  const suppliers = new Map((await listShopSuppliers(session.shopId, { includeInactive: true })).map((supplier) => [supplier.id, supplier.name]));
  return rows.map((row) => ({ ...row, supplierName: suppliers.get(row.supplierId) ?? "Supplier" }));
}

export async function getPurchaseOrder(session: SessionContext, orderId: string) {
  await requirePermission(session, PURCHASES_VIEW);
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) throw new NotFoundError("Purchase order not found.");
  const db = getDb();
  const [order] = await db.select().from(purchaseOrders).where(and(eq(purchaseOrders.id, orderId), eq(purchaseOrders.shopId, session.shopId))).limit(1);
  if (!order) throw new NotFoundError("Purchase order not found.");
  const lines = await db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, order.id)).orderBy(asc(purchaseOrderLines.createdAt));
  const [received, supplier, products, receipts, canReceive, canCancel] = await Promise.all([
    receivedByLine(db, lines.map((line) => line.id)),
    findSupplier(session.shopId, order.supplierId),
    loadProductsForStock(session.shopId, lines.map((line) => line.productId)),
    db.select({ id: goodsReceipts.id, number: goodsReceipts.number, receivedDate: goodsReceipts.receivedDate, totalPaise: goodsReceipts.totalPaise, status: goodsReceipts.status, supplierBillNo: goodsReceipts.supplierBillNo }).from(goodsReceipts).where(eq(goodsReceipts.purchaseOrderId, order.id)).orderBy(asc(goodsReceipts.createdAt)),
    hasPermission(session, STOCK_RECEIVE),
    hasPermission(session, PURCHASES_CANCEL),
  ]);
  const byId = new Map(products.map((product) => [product.id, product]));
  return {
    ...order,
    supplier: { id: supplier.id, name: supplier.name },
    lines: lines.map((line) => {
      const product = byId.get(line.productId);
      const factor = parseQuantity(line.factor);
      const orderedBase = toBaseQuantity(parseQuantity(line.qtyOrdered), factor) ?? BigInt(0);
      const receivedBase = received.get(line.id) ?? BigInt(0);
      const leftBase = orderedBase > receivedBase ? orderedBase - receivedBase : BigInt(0);
      // What is left, in the order's own unit when it divides exactly, for the receive form default.
      const leftInUnit = (leftBase * ONE_UNIT) % factor === BigInt(0) ? formatQuantity((leftBase * ONE_UNIT) / factor) : null;
      return {
        id: line.id,
        productId: line.productId,
        productName: product?.name ?? "Unknown product",
        baseUnit: product?.baseUnit ?? "",
        gstRateBp: product?.gstRateBp ?? 0,
        unit: line.unit,
        factor: formatQuantity(factor),
        qtyOrdered: formatQuantity(parseQuantity(line.qtyOrdered)),
        costPaisePerUnit: line.costPaisePerUnit,
        orderedBase: formatQuantity(orderedBase),
        receivedBase: formatQuantity(receivedBase),
        leftBase: formatQuantity(leftBase),
        leftInUnit,
      };
    }),
    receipts,
    canReceive: canReceive && (order.status === "ordered" || order.status === "partially_received"),
    canCancel: canCancel && order.status === "ordered",
    canClose: canCancel && order.status === "partially_received",
  };
}

export async function getGoodsReceipt(session: SessionContext, receiptId: string) {
  await requirePermission(session, PURCHASES_VIEW);
  if (!/^[0-9a-f-]{36}$/i.test(receiptId)) throw new NotFoundError("Receipt not found.");
  const db = getDb();
  const [receipt] = await db.select().from(goodsReceipts).where(and(eq(goodsReceipts.id, receiptId), eq(goodsReceipts.shopId, session.shopId))).limit(1);
  if (!receipt) throw new NotFoundError("Receipt not found.");
  const lines = await db.select().from(goodsReceiptLines).where(eq(goodsReceiptLines.goodsReceiptId, receipt.id)).orderBy(asc(goodsReceiptLines.createdAt));
  const [products, supplier, users, shop, order, canCancel] = await Promise.all([
    loadProductNames(session.shopId, lines.map((line) => line.productId)),
    findSupplier(session.shopId, receipt.supplierId),
    loadUserNames(session.shopId, [receipt.createdBy, ...(receipt.cancelledBy ? [receipt.cancelledBy] : [])]),
    getCurrentShop(session),
    receipt.purchaseOrderId ? db.select({ id: purchaseOrders.id, number: purchaseOrders.number }).from(purchaseOrders).where(eq(purchaseOrders.id, receipt.purchaseOrderId)).then((rows) => rows[0] ?? null) : Promise.resolve(null),
    hasPermission(session, PURCHASES_CANCEL),
  ]);
  return {
    ...receipt,
    shop,
    supplier: { id: supplier.id, name: supplier.name, phone: supplier.phone, gstin: supplier.gstin },
    order,
    lines: lines.map((line) => ({
      id: line.id,
      productName: products.get(line.productId)?.name ?? "Unknown product",
      baseUnit: products.get(line.productId)?.baseUnit ?? "",
      unit: line.unit ?? products.get(line.productId)?.baseUnit ?? "",
      qty: line.qty ? formatQuantity(parseQuantity(line.qty)) : formatQuantity(parseQuantity(line.qtyBase)),
      qtyBase: formatQuantity(parseQuantity(line.qtyBase)),
      costPaisePerUnit: line.costPaisePerUnit ?? line.unitCostPaise,
      unitCostPaise: line.unitCostPaise,
      linePaise: line.linePaise,
      gstRateBp: line.gstRateBp,
      gstPaise: line.gstPaise,
    })),
    createdByName: users.get(receipt.createdBy) ?? "Unknown user",
    cancelledByName: receipt.cancelledBy ? (users.get(receipt.cancelledBy) ?? "Unknown user") : null,
    canCancel: canCancel && receipt.status === "received",
  };
}

/** Products that can be bought: active, with units and the GST rate to pre-fill. */
export async function purchasableProducts(session: SessionContext) {
  await requirePermission(session, PURCHASES_EDIT);
  const list = await listShopProductsForStock(session.shopId);
  const withUnits = await loadProductsForStock(session.shopId, list.map((product) => product.id));
  const order = new Map(list.map((product, index) => [product.id, index]));
  return withUnits
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map((product) => ({
      id: product.id,
      name: product.name,
      sku: product.sku,
      baseUnit: product.baseUnit,
      gstRateBp: product.gstRateBp,
      units: [{ code: product.baseUnit, label: product.baseUnitName }, ...product.saleUnits.map((unit) => ({ code: unit.code, label: `${unit.name} of ${formatQuantity(unit.factor)}` }))],
    }));
}
