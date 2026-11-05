import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { postPayment, postPurchaseReturn } from "@/modules/accounting";
import { recordAudit } from "@/modules/audit";
import { loadProductNames, lockProductsForStock } from "@/modules/catalog";
import { hasPermission, loadUserNames, requirePermission, type SessionContext } from "@/modules/identity";
import { appendStockMovement, availableStock, godownList, lockStockRows, originalGodowns } from "@/modules/inventory";
import { appendLedgerEntry, lockPartyBalance } from "@/modules/ledger";
import { findSupplier } from "@/modules/parties";
import { recordSupplierRefund } from "@/modules/payments";
import { getCurrentShop, takeDocumentNumber } from "@/modules/settings";
import { withIdempotency } from "@/modules/sync";
import { lockDayForWrite } from "@/server/day-lock";
import { getDb, withTransaction } from "@/server/db";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import { indiaDate } from "@/shared/financial-year";
import { formatQuantity, parseQuantity, toBaseQuantity, toDbQuantity, type Milli } from "@/shared/quantity";
import { PURCHASES_EDIT, PURCHASES_VIEW, SUPPLIERS_PAY } from "./permissions";
import { godowns as godownTable } from "../inventory/schema";
import { goodsReceiptLines, goodsReceipts, purchaseReturnLines, purchaseReturns, PURCHASE_RETURN_SETTLEMENTS, REFUND_METHODS } from "./schema";

/**
 * Purchase returns and supplier debit notes. Goods are returned from an existing receipt: each line keeps the receipt line's own
 * unit, conversion factor, cost and GST, never repriced, and can't go past what that line received and has not yet sent back.
 * One transaction writes the return (which is the debit note), the stock leaving, the supplier ledger debit, a refund (if the
 * supplier pays back) as a genuine incoming payment, the journal and the audit row.
 */

const actorOf = (session: SessionContext) => ({ shopId: session.shopId, userId: session.userId, role: session.role });
const booksOf = (session: SessionContext) => ({ shopId: session.shopId, userId: session.userId });
const UUID = /^[0-9a-f-]{36}$/i;

const half = (numerator: bigint, denominator: bigint) => (numerator * BigInt(2) + denominator) / (denominator * BigInt(2));

export const purchaseReturnInputSchema = z
  .object({
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, "This form has expired. Reload the page."),
    goodsReceiptId: z.string().regex(UUID, "Choose a receipt."),
    /** Where the goods leave from. Left out: the godown the receipt came into. */
    godownId: z.string().trim().optional(),
    reason: z.string().trim().min(3, "Write a short reason (at least 3 characters).").max(200, "Keep the reason under 200 characters."),
    settlement: z.enum(PURCHASE_RETURN_SETTLEMENTS, { message: "Choose how the supplier settles." }),
    refundMethod: z.enum(["", ...REFUND_METHODS]).optional(),
    lines: z.array(z.object({ receiptLineId: z.string().regex(UUID, "Choose a line."), quantity: z.string().trim() })).min(1, "Choose what to return.").max(100),
  })
  .superRefine((data, ctx) => {
    if (data.settlement === "refund" && !data.refundMethod) ctx.addIssue({ code: "custom", path: ["refundMethod"], message: "Choose how the supplier pays you back." });
    const seen = new Set<string>();
    data.lines.forEach((line, index) => {
      if (seen.has(line.receiptLineId)) ctx.addIssue({ code: "custom", path: ["lines", index, "receiptLineId"], message: "This line is already on the return." });
      seen.add(line.receiptLineId);
    });
  });

export type ReturnableLine = { receiptLineId: string; productId: string; productName: string; unit: string; factor: string; receivedQty: string; returnedQty: string; remainingQty: string; remainingBase: string; unitCostPaise: number; gstRateBp: number };

/** What can still be returned from each line of a receipt, in the unit the goods were received in. */
async function returnableForReceipt(db: ReturnType<typeof getDb> | Parameters<Parameters<typeof withTransaction>[0]>[0], shopId: string, receiptId: string) {
  const lines = await db.select().from(goodsReceiptLines).where(eq(goodsReceiptLines.goodsReceiptId, receiptId)).orderBy(asc(goodsReceiptLines.createdAt));
  const done = await db.execute<{ receipt_line_id: string; base: string; taxable: string; gst: string }>(sql`
    select l.receipt_line_id, sum(l.qty_base)::text as base, sum(l.taxable_paise)::text as taxable, sum(l.gst_paise)::text as gst
    from purchase_return_lines l join purchase_returns r on r.id = l.purchase_return_id
    where r.shop_id = ${shopId} and r.goods_receipt_id = ${receiptId} group by l.receipt_line_id`);
  const returned = new Map(done.rows.map((row) => [row.receipt_line_id, { base: parseQuantity(row.base), taxable: Number(row.taxable), gst: Number(row.gst) }]));
  return { lines, returned };
}

export async function listReturnableLines(session: SessionContext, receiptId: string): Promise<{ lines: ReturnableLine[]; godownId: string | null; canRefund: boolean }> {
  await requirePermission(session, PURCHASES_VIEW);
  if (!UUID.test(receiptId)) throw new NotFoundError("Receipt not found.");
  const db = getDb();
  const [receipt] = await db.select().from(goodsReceipts).where(and(eq(goodsReceipts.id, receiptId), eq(goodsReceipts.shopId, session.shopId))).limit(1);
  if (!receipt) throw new NotFoundError("Receipt not found.");
  const { lines, returned } = await returnableForReceipt(db, session.shopId, receipt.id);
  const names = await loadProductNames(session.shopId, lines.map((line) => line.productId));
  const home = await originalGodowns(db, session.shopId, "goods_receipt", receipt.id);
  return {
    godownId: [...home.values()][0] ?? null,
    canRefund: await hasPermission(session, SUPPLIERS_PAY),
    lines: lines.map((line) => {
      const factor = parseQuantity(line.factor);
      const base = parseQuantity(line.qtyBase);
      const back = returned.get(line.id)?.base ?? BigInt(0);
      const remainingBase = base - back;
      const unit = line.unit ?? names.get(line.productId)?.baseUnit ?? "";
      const entered = line.qty ? factor : BigInt(1000);
      return {
        receiptLineId: line.id,
        productId: line.productId,
        productName: names.get(line.productId)?.name ?? "Unknown product",
        unit,
        factor: formatQuantity(entered),
        receivedQty: formatQuantity(line.qty ? parseQuantity(line.qty) : base),
        returnedQty: formatQuantity(entered === BigInt(0) ? BigInt(0) : (back * BigInt(1000)) / entered),
        remainingQty: formatQuantity(entered === BigInt(0) ? BigInt(0) : (remainingBase * BigInt(1000)) / entered),
        remainingBase: formatQuantity(remainingBase),
        unitCostPaise: line.unitCostPaise,
        gstRateBp: line.gstRateBp,
      };
    }),
  };
}

export type CreatedPurchaseReturn = { id: string; number: string; totalPaise: number; replayed: boolean };

export async function createPurchaseReturn(session: SessionContext, input: unknown): Promise<CreatedPurchaseReturn> {
  await requirePermission(session, PURCHASES_EDIT);
  const data = purchaseReturnInputSchema.parse(input);
  const { idempotencyKey, ...body } = data;
  // A refund is money coming in from a supplier: only people who may record supplier money can choose it.
  if (data.settlement === "refund") await requirePermission(session, SUPPLIERS_PAY);
  return withTransaction(async (tx) => {
    const outcome = await withIdempotency<Omit<CreatedPurchaseReturn, "replayed">>(tx, { shopId: session.shopId, userId: session.userId, key: idempotencyKey }, { action: "purchasing.return", ...body }, async () => {
      const today = indiaDate();
      await lockDayForWrite(tx, session.shopId, today);
      const [receipt] = await tx.select().from(goodsReceipts).where(and(eq(goodsReceipts.id, data.goodsReceiptId), eq(goodsReceipts.shopId, session.shopId))).limit(1).for("update");
      if (!receipt) throw new NotFoundError("Receipt not found.");
      if (receipt.status === "cancelled") throw new ConflictError("RECEIPT_CANCELLED", "This receipt is cancelled, so nothing can be returned from it.");
      const supplier = await findSupplier(session.shopId, receipt.supplierId, tx);
      const { lines: receiptLines, returned } = await returnableForReceipt(tx, session.shopId, receipt.id);
      const byId = new Map(receiptLines.map((line) => [line.id, line]));
      const products = new Map((await lockProductsForStock(tx, session.shopId, receiptLines.map((line) => line.productId))).map((product) => [product.id, product]));

      // 1. What is returned, checked against what the receipt line received and has not already sent back.
      const planned = data.lines.map((requested, index) => {
        const line = byId.get(requested.receiptLineId);
        if (!line) throw new ValidationError("This line is not on the receipt.", { fieldErrors: { [`lines.${index}.receiptLineId`]: "Not on this receipt." } });
        const factor = parseQuantity(line.factor);
        const entered = line.qty ? factor : BigInt(1000);
        const unit = line.unit ?? products.get(line.productId)?.baseUnit ?? "";
        let quantity: Milli;
        try {
          quantity = parseQuantity(requested.quantity);
        } catch {
          throw new ValidationError("Enter a quantity with up to 3 decimal places.", { fieldErrors: { [`lines.${index}.quantity`]: "Enter a quantity." } });
        }
        if (quantity <= BigInt(0)) throw new ValidationError("Enter a quantity above zero.", { fieldErrors: { [`lines.${index}.quantity`]: "Must be above zero." } });
        const base = line.qty ? toBaseQuantity(quantity, factor) : quantity;
        if (base === null) throw new ValidationError("That quantity can't be stored exactly. Use fewer decimal places.", { fieldErrors: { [`lines.${index}.quantity`]: "Use fewer decimal places." } });
        const product = products.get(line.productId);
        if (product && !product.baseAllowsDecimal && base % BigInt(1000) !== BigInt(0)) throw new ValidationError(`${product.baseUnitName} can't be split, so this must come to a whole number of ${product.baseUnit}.`, { fieldErrors: { [`lines.${index}.quantity`]: "Whole numbers only." } });
        const before = returned.get(line.id) ?? { base: BigInt(0), taxable: 0, gst: 0 };
        const receivedBase = parseQuantity(line.qtyBase);
        const remaining = receivedBase - before.base;
        if (base > remaining) {
          const left = entered === BigInt(0) ? BigInt(0) : (remaining * BigInt(1000)) / entered;
          throw new ConflictError("RETURN_TOO_MUCH", `Only ${formatQuantity(left)} ${unit} of ${product?.name ?? "this item"} can still be returned from this receipt.`, { fieldErrors: { [`lines.${index}.quantity`]: `Only ${formatQuantity(left)} left to return.` } });
        }
        // Value: the receipt line's own value and GST, in proportion; the last unit returned takes the exact remainder so nothing is lost to rounding.
        const lastOfLine = base === remaining;
        const taxable = lastOfLine ? line.linePaise - before.taxable : Number(half(BigInt(line.linePaise) * base, receivedBase));
        const gst = lastOfLine ? line.gstPaise - before.gst : Number(half(BigInt(line.gstPaise) * base, receivedBase));
        return { line, product, unit, factor: line.qty ? factor : BigInt(1000), quantity, base, taxable, gst };
      });
      const taxablePaise = planned.reduce((sum, line) => sum + line.taxable, 0);
      const gstPaise = planned.reduce((sum, line) => sum + line.gst, 0);
      const totalPaise = taxablePaise + gstPaise;
      if (totalPaise <= 0) throw new ValidationError("This return works out to nothing. Check the quantities.");

      // 2. Where the goods leave from: the godown they came into, unless that one no longer holds them and another is chosen.
      const home = await originalGodowns(tx, session.shopId, "goods_receipt", receipt.id);
      const places = await godownList(tx, session.shopId);
      const homeId = [...home.values()][0];
      let godownId: string;
      if (data.godownId) {
        if (!places.some((place) => place.id === data.godownId)) throw new ValidationError("Choose one of your godowns.", { fieldErrors: { godownId: "Choose a godown." } });
        godownId = data.godownId;
      } else {
        godownId = homeId ?? places.find((place) => place.isDefault)?.id ?? places[0]!.id;
      }
      await lockStockRows(tx, session.shopId, planned.map((line) => line.line.productId), [godownId]);
      const stock = await availableStock(tx, session.shopId, planned.map((line) => line.line.productId), { godownId });
      for (const line of planned) {
        const have = stock.get(line.line.productId)?.available ?? BigInt(0);
        if (have < line.base) {
          const moved = !data.godownId && places.length > 1;
          throw new ConflictError(moved ? "GODOWN_REQUIRED" : "NEGATIVE_STOCK", moved ? `Only ${formatQuantity(have)} ${line.product?.baseUnit ?? ""} of ${line.product?.name ?? "this item"} is left where it came in. Choose the godown to return from.` : `Only ${formatQuantity(have)} ${line.product?.baseUnit ?? ""} of ${line.product?.name ?? "this item"} is available, less than ${formatQuantity(line.base)} (some may be set aside for orders).`, { fieldErrors: { [moved ? "godownId" : "lines.0.quantity"]: moved ? "Choose a godown." : "Not enough stock." } });
        }
      }

      // 3. One transaction: supplier balance, number, the return, stock, ledger, refund, journal, audit.
      await lockPartyBalance(tx, session.shopId, "supplier", supplier.id);
      const { fy, number } = await takeDocumentNumber(tx, session.shopId, "DN");
      const returnId = randomUUID();
      let refundPaymentId: string | null = null;
      if (data.settlement === "refund") refundPaymentId = await recordSupplierRefund(tx, { shopId: session.shopId, fy, supplierId: supplier.id, method: data.refundMethod as "cash" | "upi" | "bank" | "cheque", amountPaise: totalPaise, businessDate: today, recordedBy: session.userId });
      await tx.insert(purchaseReturns).values({ id: returnId, shopId: session.shopId, fy, number, goodsReceiptId: receipt.id, supplierId: supplier.id, godownId, returnDate: today, reason: data.reason, settlement: data.settlement, refundMethod: data.settlement === "refund" ? (data.refundMethod as "cash" | "upi" | "bank" | "cheque") : null, refundPaymentId, taxablePaise, gstPaise, totalPaise, createdBy: session.userId });
      await tx.insert(purchaseReturnLines).values(
        planned.map((line) => ({ purchaseReturnId: returnId, receiptLineId: line.line.id, productId: line.line.productId, unit: line.unit, factor: toDbQuantity(line.factor), qty: toDbQuantity(line.quantity), qtyBase: toDbQuantity(line.base), unitCostPaise: line.line.unitCostPaise, taxablePaise: line.taxable, gstRateBp: line.line.gstRateBp, gstPaise: line.gst })),
      );
      for (const line of planned) {
        await appendStockMovement(tx, { shopId: session.shopId, productId: line.line.productId, godownId, movementDate: today, kind: "return_out", qtyBase: -line.base, unitCostPaise: line.line.unitCostPaise, sourceType: "purchase_return", sourceId: returnId, reason: `${number}: ${data.reason}`, entered: { qty: toDbQuantity(line.quantity), unit: line.unit, factor: toDbQuantity(line.factor) }, createdBy: session.userId });
      }
      await appendLedgerEntry(tx, { shopId: session.shopId, partyType: "supplier", partyId: supplier.id, entryDate: today, kind: "debit_note", sourceType: "purchase_return", sourceId: returnId, debitPaise: totalPaise });
      if (refundPaymentId) {
        await appendLedgerEntry(tx, { shopId: session.shopId, partyType: "supplier", partyId: supplier.id, entryDate: today, kind: "payment", sourceType: "payment", sourceId: refundPaymentId, creditPaise: totalPaise });
      }
      await postPurchaseReturn(tx, booksOf(session), { returnId, receiptId: receipt.id, date: today, supplierId: supplier.id, taxablePaise, gstPaise, totalPaise });
      if (refundPaymentId) await postPayment(tx, booksOf(session), { paymentId: refundPaymentId, date: today, direction: "in", partyType: "supplier", partyId: supplier.id, method: data.refundMethod!, amountPaise: totalPaise });
      await recordAudit(tx, actorOf(session), {
        action: "purchasing.return_created",
        entityType: "purchase_return",
        entityId: returnId,
        after: { number, receiptId: receipt.id, supplierId: supplier.id, godownId, settlement: data.settlement, totalPaise, gstPaise, lines: planned.map((line) => ({ productId: line.line.productId, qtyBase: formatQuantity(line.base) })) },
        reason: data.reason,
      });
      return { status: 201, body: { id: returnId, number, totalPaise } };
    });
    return { ...outcome.body, replayed: outcome.replayed };
  });
}

export async function listPurchaseReturns(session: SessionContext, filters: { receiptId?: string; supplierId?: string } = {}) {
  await requirePermission(session, PURCHASES_VIEW);
  const db = getDb();
  const rows = await db
    .select({ id: purchaseReturns.id, number: purchaseReturns.number, returnDate: purchaseReturns.returnDate, totalPaise: purchaseReturns.totalPaise, settlement: purchaseReturns.settlement, goodsReceiptId: purchaseReturns.goodsReceiptId, supplierId: purchaseReturns.supplierId })
    .from(purchaseReturns)
    .where(and(eq(purchaseReturns.shopId, session.shopId), filters.receiptId && UUID.test(filters.receiptId) ? eq(purchaseReturns.goodsReceiptId, filters.receiptId) : undefined, filters.supplierId && UUID.test(filters.supplierId) ? eq(purchaseReturns.supplierId, filters.supplierId) : undefined))
    .orderBy(desc(purchaseReturns.createdAt))
    .limit(100);
  return rows;
}

/** A return as a printable debit note: supplier, receipt, lines at the receipt's own unit, cost and GST, and how it was settled. */
export async function getPurchaseReturn(session: SessionContext, returnId: string) {
  await requirePermission(session, PURCHASES_VIEW);
  if (!UUID.test(returnId)) throw new NotFoundError("Debit note not found.");
  const db = getDb();
  const [ret] = await db.select().from(purchaseReturns).where(and(eq(purchaseReturns.id, returnId), eq(purchaseReturns.shopId, session.shopId))).limit(1);
  if (!ret) throw new NotFoundError("Debit note not found.");
  const [lines, supplier, receipt, shop, users, places] = await Promise.all([
    db.select().from(purchaseReturnLines).where(eq(purchaseReturnLines.purchaseReturnId, ret.id)),
    findSupplier(session.shopId, ret.supplierId),
    db.select({ id: goodsReceipts.id, number: goodsReceipts.number, supplierBillNo: goodsReceipts.supplierBillNo }).from(goodsReceipts).where(eq(goodsReceipts.id, ret.goodsReceiptId)).then((rows) => rows[0]!),
    getCurrentShop(session),
    loadUserNames(session.shopId, [ret.createdBy]),
    db.select({ name: godownTable.name }).from(godownTable).where(eq(godownTable.id, ret.godownId)),
  ]);
  const names = await loadProductNames(session.shopId, lines.map((line) => line.productId));
  return {
    ...ret,
    shop,
    supplier: { id: supplier.id, name: supplier.name, phone: supplier.phone, gstin: supplier.gstin },
    receipt,
    godownName: places[0]?.name ?? "",
    createdByName: users.get(ret.createdBy) ?? "Unknown user",
    lines: lines.map((line) => ({ id: line.id, productName: names.get(line.productId)?.name ?? "Unknown product", unit: line.unit, qty: formatQuantity(parseQuantity(line.qty)), qtyBase: formatQuantity(parseQuantity(line.qtyBase)), unitCostPaise: line.unitCostPaise, taxablePaise: line.taxablePaise, gstRateBp: line.gstRateBp, gstPaise: line.gstPaise })),
  };
}

/** Whether a receipt has any returns, so it can't be cancelled underneath them. */
export async function receiptHasReturns(tx: Parameters<Parameters<typeof withTransaction>[0]>[0], shopId: string, receiptId: string): Promise<boolean> {
  const [row] = await tx.select({ id: purchaseReturns.id }).from(purchaseReturns).where(and(eq(purchaseReturns.shopId, shopId), eq(purchaseReturns.goodsReceiptId, receiptId))).limit(1);
  return Boolean(row);
}
