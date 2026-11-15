import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { postDelivery, postDeliveryCancelled } from "@/modules/accounting";
import { recordAudit } from "@/modules/audit";
import { lockProductsForStock, type ProductStockUnits } from "@/modules/catalog";
import { hasPermission, loadUserNames, requirePermission, type SessionContext } from "@/modules/identity";
import { addReservation, appendStockMovement, availableStock, consumeReservation, godownList, lockStockRows, originalGodowns, releaseOrderReservations, reservationsForOrder, resolveGodown } from "@/modules/inventory";
import { findCustomer } from "@/modules/parties";
import { defaultPriceList, priceBillLine } from "@/modules/pricing";
import { getCurrentShop, takeDocumentNumber } from "@/modules/settings";
import { withIdempotency } from "@/modules/sync";
import { getDb, withTransaction, type Database, type Transaction } from "@/server/db";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import { indiaDate } from "@/shared/financial-year";
import { formatQuantity, parseQuantity, toBaseQuantity, toDbQuantity, type Milli } from "@/shared/quantity";
import { BILLING_CREATE, BILLING_VIEW, INVOICE_CANCEL } from "./permissions";
import { deliveryChallanLines, deliveryChallans, invoiceChallanLinks, salesOrderLines, salesOrders, type SALES_ORDER_STATUSES } from "./schema";

/**
 * Sales orders, stock reservations and delivery challans: an optional path, Order → Deliver → Bill, beside direct billing.
 * - An order never moves stock. Confirming it reserves stock (available = physical - reserved).
 * - A delivery challan is where physical stock leaves, exactly once, at the cost of the day it left.
 * - A bill made from delivered goods (see challan-billing.ts) moves money only.
 * Lock order: order row -> products -> stock rows (product, godown) -> reservation rows -> number series -> journal.
 */

type Db = Database | Transaction;
type Status = (typeof SALES_ORDER_STATUSES)[number];
const actorOf = (session: SessionContext) => ({ shopId: session.shopId, userId: session.userId, role: session.role });
const booksOf = (session: SessionContext) => ({ shopId: session.shopId, userId: session.userId });
const UUID = /^[0-9a-f-]{36}$/i;
const ZERO = BigInt(0);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const keySchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, "This form has expired. Reload the page.");
const reasonSchema = z.object({ reason: z.string().trim().min(3, "Write a short reason (at least 3 characters).").max(200, "Keep the reason under 200 characters.") });

export const salesOrderInputSchema = z
  .object({
    idempotencyKey: keySchema,
    customerId: z.string().regex(UUID, "Choose a customer."),
    expectedDate: z.string().trim().optional(),
    notes: z.string().trim().max(300, "Keep the note under 300 characters.").optional().default(""),
    /** Confirm straight away (reserves stock); otherwise it stays a draft. */
    confirm: z.boolean().optional().default(false),
    /** Where stock is reserved when confirming; required once the shop has several godowns. */
    godownId: z.string().trim().optional(),
    lines: z.array(z.object({ productId: z.string().regex(UUID, "Choose a product."), unit: z.string().trim().min(1, "Choose a unit."), quantity: z.string().trim().min(1, "Enter a quantity.") })).min(1, "Add at least one item to the order.").max(100),
  })
  .superRefine((data, ctx) => {
    if (data.expectedDate && !DATE.test(data.expectedDate)) ctx.addIssue({ code: "custom", path: ["expectedDate"], message: "Choose a valid date." });
    const seen = new Map<string, number>();
    data.lines.forEach((line, index) => {
      const first = seen.get(line.productId);
      if (first !== undefined) ctx.addIssue({ code: "custom", path: ["lines", index, "productId"], message: `This product is already on line ${first + 1}.` });
      else seen.set(line.productId, index);
    });
  });

/** Per order line: ordered, reserved, delivered, billed and what is still pending, all in base units (and the ordered unit for display). */
export type OrderLineView = {
  id: string;
  lineNo: number;
  productId: string;
  productName: string;
  unit: string;
  factor: string;
  orderedQty: string;
  orderedBase: string;
  reservedBase: string;
  deliveredBase: string;
  billedBase: string;
  /** Not yet delivered (ordered - delivered), and the part of it that has no reserved stock behind it. */
  pendingBase: string;
  shortBase: string;
  indicativeRatePaise: number;
};

async function loadOrder(db: Db, shopId: string, orderId: string, lock = false) {
  if (!UUID.test(orderId)) throw new NotFoundError("Order not found.");
  const query = db.select().from(salesOrders).where(and(eq(salesOrders.id, orderId), eq(salesOrders.shopId, shopId))).limit(1);
  const [order] = await (lock ? query.for("update") : query);
  if (!order) throw new NotFoundError("Order not found.");
  return order;
}

/** Delivered and billed base quantities per order line, from live (not cancelled / not released) challans and links. */
async function progress(db: Db, shopId: string, orderId: string) {
  const delivered = await db.execute<{ order_line_id: string; qty: string }>(sql`
    select l.order_line_id, sum(l.base_qty)::text as qty from delivery_challan_lines l join delivery_challans c on c.id = l.challan_id
    where c.shop_id = ${shopId} and c.order_id = ${orderId} and c.status = 'delivered' group by l.order_line_id`);
  const billed = await db.execute<{ order_line_id: string; qty: string }>(sql`
    select l.order_line_id, sum(k.base_qty)::text as qty from invoice_challan_links k
    join delivery_challan_lines l on l.id = k.challan_line_id join delivery_challans c on c.id = l.challan_id
    where k.shop_id = ${shopId} and c.order_id = ${orderId} and k.released_at is null group by l.order_line_id`);
  return { delivered: new Map(delivered.rows.map((row) => [row.order_line_id, parseQuantity(row.qty)])), billed: new Map(billed.rows.map((row) => [row.order_line_id, parseQuantity(row.qty)])) };
}

function statusFor(order: { status: string; closedAt: Date | null }, lines: { baseQty: string; id: string }[], delivered: Map<string, Milli>): Status {
  if (order.status === "cancelled") return "cancelled";
  if (order.status === "draft") return "draft";
  const any = lines.some((line) => (delivered.get(line.id) ?? ZERO) > ZERO);
  if (order.closedAt && any) return "delivered";
  if (lines.every((line) => (delivered.get(line.id) ?? ZERO) >= parseQuantity(line.baseQty))) return "delivered";
  return any ? "partially_delivered" : "confirmed";
}

async function refreshStatus(tx: Transaction, shopId: string, orderId: string) {
  const order = await loadOrder(tx, shopId, orderId);
  const lines = await tx.select().from(salesOrderLines).where(eq(salesOrderLines.orderId, orderId));
  const { delivered } = await progress(tx, shopId, orderId);
  const next = statusFor(order, lines, delivered);
  if (next !== order.status) await tx.update(salesOrders).set({ status: next }).where(eq(salesOrders.id, orderId));
  return next;
}

export type CreatedOrder = { id: string; number: string; replayed: boolean };

export async function createSalesOrder(session: SessionContext, input: unknown): Promise<CreatedOrder> {
  await requirePermission(session, BILLING_CREATE);
  const data = salesOrderInputSchema.parse(input);
  const { idempotencyKey, ...body } = data;
  return withTransaction(async (tx) => {
    const outcome = await withIdempotency<Omit<CreatedOrder, "replayed">>(tx, { shopId: session.shopId, userId: session.userId, key: idempotencyKey }, { action: "sales.order", ...body }, async () => {
      const customer = await findCustomer(session.shopId, data.customerId, tx);
      if (!customer.isActive) throw new ConflictError("CUSTOMER_INACTIVE", `${customer.name} is switched off.`);
      if (customer.type === "walkin") throw new ValidationError("Choose a customer for the order.", { fieldErrors: { customerId: "Choose a customer." } });
      const priceList = defaultPriceList(customer);
      const priced = [];
      for (const [index, line] of data.lines.entries()) {
        let quantity: Milli;
        try {
          quantity = parseQuantity(line.quantity);
        } catch {
          throw new ValidationError("Enter a quantity with up to 3 decimal places.", { fieldErrors: { [`lines.${index}.quantity`]: "Enter a quantity." } });
        }
        if (quantity <= ZERO) throw new ValidationError("Enter a quantity above zero.", { fieldErrors: { [`lines.${index}.quantity`]: "Must be above zero." } });
        priced.push(await priceBillLine(tx, session.shopId, { productId: line.productId, unit: line.unit, quantity, customer, priceList }));
      }
      const orderId = randomUUID();
      const { fy, number } = await takeDocumentNumber(tx, session.shopId, "SO");
      await tx.insert(salesOrders).values({ id: orderId, shopId: session.shopId, fy, number, customerId: customer.id, status: "draft", orderDate: indiaDate(), expectedDate: data.expectedDate || null, notes: data.notes || null, createdBy: session.userId });
      await tx.insert(salesOrderLines).values(
        priced.map((line, index) => ({ id: randomUUID(), orderId, lineNo: index + 1, productId: line.product.id, unit: line.saleUnit.code, factor: toDbQuantity(line.saleUnit.factor), qty: toDbQuantity(line.quote.quantity), baseQty: toDbQuantity(line.quote.baseQuantity), indicativeRatePaise: line.quote.saleUnitRatePaise, productName: line.product.name })),
      );
      await recordAudit(tx, actorOf(session), { action: "sales.order_created", entityType: "sales_order", entityId: orderId, after: { number, customerId: customer.id, lines: priced.length } });
      if (data.confirm) await confirmWithin(tx, session, orderId, data.godownId);
      return { status: 201, body: { id: orderId, number } };
    });
    return { ...outcome.body, replayed: outcome.replayed };
  });
}

/** Reserves what stock allows for every line that still needs it, in the order's godown. Shortages are not an error: they stay pending. */
async function reserveWithin(tx: Transaction, session: SessionContext, orderId: string, godownId: string) {
  const lines = await tx.select().from(salesOrderLines).where(eq(salesOrderLines.orderId, orderId)).orderBy(asc(salesOrderLines.productId));
  const { delivered } = await progress(tx, session.shopId, orderId);
  await lockStockRows(tx, session.shopId, lines.map((line) => line.productId), [godownId]);
  const stock = await availableStock(tx, session.shopId, lines.map((line) => line.productId), { godownId });
  const held = await reservationsForOrder(session.shopId, orderId, tx);
  const result: { lineId: string; reserved: Milli }[] = [];
  for (const line of lines) {
    const need = parseQuantity(line.baseQty) - (delivered.get(line.id) ?? ZERO) - (held.get(line.id)?.qty ?? ZERO);
    if (need <= ZERO) continue;
    const room = stock.get(line.productId)?.available ?? ZERO;
    const take = room < need ? (room > ZERO ? room : ZERO) : need;
    if (take > ZERO) {
      await addReservation(tx, { shopId: session.shopId, orderId, orderLineId: line.id, productId: line.productId, godownId, qtyBase: take });
      stock.set(line.productId, { ...stock.get(line.productId)!, available: room - take });
      result.push({ lineId: line.id, reserved: take });
    }
  }
  return result;
}

async function confirmWithin(tx: Transaction, session: SessionContext, orderId: string, requestedGodown?: string) {
  const order = await loadOrder(tx, session.shopId, orderId, true);
  if (order.status !== "draft") throw new ConflictError("ORDER_NOT_DRAFT", "This order is already confirmed.");
  const lineRows = await tx.select().from(salesOrderLines).where(eq(salesOrderLines.orderId, orderId));
  await lockProductsForStock(tx, session.shopId, lineRows.map((line) => line.productId));
  const godownId = await resolveGodown(tx, session.shopId, requestedGodown, "dispatch");
  await tx.update(salesOrders).set({ status: "confirmed", confirmedAt: new Date(), godownId }).where(eq(salesOrders.id, orderId));
  const reserved = await reserveWithin(tx, session, orderId, godownId);
  await recordAudit(tx, actorOf(session), { action: "sales.order_confirmed", entityType: "sales_order", entityId: orderId, after: { godownId, reservedLines: reserved.length } });
}

export async function confirmSalesOrder(session: SessionContext, orderId: string, input: { godownId?: string } = {}): Promise<void> {
  await requirePermission(session, BILLING_CREATE);
  await withTransaction((tx) => confirmWithin(tx, session, orderId, input.godownId));
}

/** Sets aside more stock for an order whose lines were short, using whatever is available now. */
export async function reserveOrderStock(session: SessionContext, orderId: string): Promise<{ reservedLines: number }> {
  await requirePermission(session, BILLING_CREATE);
  return withTransaction(async (tx) => {
    const order = await loadOrder(tx, session.shopId, orderId, true);
    if (order.status !== "confirmed" && order.status !== "partially_delivered") throw new ConflictError("ORDER_NOT_OPEN", "Stock can only be set aside for a confirmed order that is still open.");
    if (order.closedAt) throw new ConflictError("ORDER_CLOSED", "This order is closed.");
    const lineRows = await tx.select().from(salesOrderLines).where(eq(salesOrderLines.orderId, orderId));
    await lockProductsForStock(tx, session.shopId, lineRows.map((line) => line.productId));
    const reserved = await reserveWithin(tx, session, orderId, order.godownId!);
    await recordAudit(tx, actorOf(session), { action: "sales.order_reserved", entityType: "sales_order", entityId: orderId, after: { reservedLines: reserved.length } });
    return { reservedLines: reserved.length };
  });
}

/** Cancels an order nothing has been delivered against, releasing its reserved stock. */
export async function cancelSalesOrder(session: SessionContext, orderId: string, input: unknown): Promise<void> {
  await requirePermission(session, BILLING_CREATE);
  const { reason } = reasonSchema.parse(input);
  await withTransaction(async (tx) => {
    const order = await loadOrder(tx, session.shopId, orderId, true);
    if (order.status === "cancelled") throw new ConflictError("ALREADY_CANCELLED", "This order is already cancelled.");
    const { delivered } = await progress(tx, session.shopId, order.id);
    if ([...delivered.values()].some((qty) => qty > ZERO)) throw new ConflictError("HAS_DELIVERIES", "Goods were already delivered against this order, so it can't be cancelled. Close it to drop what is left.");
    await releaseOrderReservations(tx, session.shopId, order.id);
    await tx.update(salesOrders).set({ status: "cancelled", cancelledAt: new Date(), cancelReason: reason }).where(eq(salesOrders.id, order.id));
    await recordAudit(tx, actorOf(session), { action: "sales.order_cancelled", entityType: "sales_order", entityId: order.id, before: { status: order.status }, after: { status: "cancelled" }, reason });
  });
}

/** Closes a part-delivered order: what was not delivered is dropped and its reservation released. */
export async function closeSalesOrder(session: SessionContext, orderId: string, input: unknown): Promise<void> {
  await requirePermission(session, BILLING_CREATE);
  const { reason } = reasonSchema.parse(input);
  await withTransaction(async (tx) => {
    const order = await loadOrder(tx, session.shopId, orderId, true);
    if (order.status !== "partially_delivered") throw new ConflictError("ORDER_NOT_PARTIAL", "Only an order that was delivered in part can be closed.");
    await releaseOrderReservations(tx, session.shopId, order.id);
    await tx.update(salesOrders).set({ closedAt: new Date(), status: "delivered" }).where(eq(salesOrders.id, order.id));
    await recordAudit(tx, actorOf(session), { action: "sales.order_closed", entityType: "sales_order", entityId: order.id, before: { status: order.status }, after: { status: "delivered", closed: true }, reason });
  });
}

export const deliveryInputSchema = z.object({
  idempotencyKey: keySchema,
  orderId: z.string().regex(UUID, "Choose an order."),
  /** Dispatch godown: required once the shop has several. */
  godownId: z.string().trim().optional(),
  note: z.string().trim().max(200, "Keep the note under 200 characters.").optional().default(""),
  lines: z.array(z.object({ orderLineId: z.string().regex(UUID, "Choose a line."), quantity: z.string().trim() })).min(1, "Choose what to deliver.").max(100),
});

export type CreatedChallan = { id: string; number: string; replayed: boolean };

export async function createDeliveryChallan(session: SessionContext, input: unknown): Promise<CreatedChallan> {
  await requirePermission(session, BILLING_CREATE);
  const data = deliveryInputSchema.parse(input);
  const { idempotencyKey, ...body } = data;
  return withTransaction(async (tx) => {
    const outcome = await withIdempotency<Omit<CreatedChallan, "replayed">>(tx, { shopId: session.shopId, userId: session.userId, key: idempotencyKey }, { action: "sales.delivery", ...body }, async () => {
      const order = await loadOrder(tx, session.shopId, data.orderId, true);
      if (order.status !== "confirmed" && order.status !== "partially_delivered") throw new ConflictError("ORDER_NOT_OPEN", order.status === "draft" ? "Confirm the order before delivering." : "Nothing more can be delivered against this order.");
      if (order.closedAt) throw new ConflictError("ORDER_CLOSED", "This order is closed.");
      const lineRows = await tx.select().from(salesOrderLines).where(eq(salesOrderLines.orderId, order.id));
      const byId = new Map(lineRows.map((line) => [line.id, line]));
      const products = new Map((await lockProductsForStock(tx, session.shopId, lineRows.map((line) => line.productId))).map((product) => [product.id, product]));
      const godownId = await resolveGodown(tx, session.shopId, data.godownId, "dispatch");
      const { delivered } = await progress(tx, session.shopId, order.id);

      // 1. What is delivered: in the order line's own unit and factor, never more than is still pending.
      const planned = data.lines.map((requested, index) => {
        const line = byId.get(requested.orderLineId);
        if (!line) throw new ValidationError("This line is not on the order.", { fieldErrors: { [`lines.${index}.orderLineId`]: "Not on this order." } });
        let quantity: Milli;
        try {
          quantity = parseQuantity(requested.quantity);
        } catch {
          throw new ValidationError("Enter a quantity with up to 3 decimal places.", { fieldErrors: { [`lines.${index}.quantity`]: "Enter a quantity." } });
        }
        if (quantity <= ZERO) throw new ValidationError("Enter a quantity above zero.", { fieldErrors: { [`lines.${index}.quantity`]: "Must be above zero." } });
        const factor = parseQuantity(line.factor);
        const base = toBaseQuantity(quantity, factor);
        if (base === null) throw new ValidationError("That quantity can't be stored exactly. Use fewer decimal places.", { fieldErrors: { [`lines.${index}.quantity`]: "Use fewer decimal places." } });
        const product = products.get(line.productId) as ProductStockUnits | undefined;
        if (product && !product.baseAllowsDecimal && base % BigInt(1000) !== ZERO) throw new ValidationError(`${product.baseUnitName} can't be split, so this must come to a whole number of ${product.baseUnit}.`, { fieldErrors: { [`lines.${index}.quantity`]: "Whole numbers only." } });
        const pending = parseQuantity(line.baseQty) - (delivered.get(line.id) ?? ZERO);
        if (base > pending) {
          const left = (pending * BigInt(1000)) / (factor === ZERO ? BigInt(1000) : factor);
          throw new ConflictError("DELIVERY_TOO_MUCH", `Only ${formatQuantity(left)} ${line.unit} of ${line.productName} is still to be delivered on this order.`, { fieldErrors: { [`lines.${index}.quantity`]: `Only ${formatQuantity(left)} left to deliver.` } });
        }
        return { line, product, quantity, factor, base };
      });
      if (new Set(planned.map((line) => line.line.id)).size !== planned.length) throw new ValidationError("A line can only be delivered once per challan.");

      // 2. Physical stock in the godown, less what is reserved for other orders. This order's own reservation counts for it.
      await lockStockRows(tx, session.shopId, planned.map((line) => line.line.productId), [godownId]);
      const stock = await availableStock(tx, session.shopId, planned.map((line) => line.line.productId), { godownId });
      const own = await reservationsForOrder(session.shopId, order.id, tx);
      for (const line of planned) {
        const mine = own.get(line.line.id);
        const ownHere = mine && mine.godownId === godownId ? mine.qty : ZERO;
        const free = (stock.get(line.line.productId)?.available ?? ZERO) + ownHere;
        if (free < line.base) throw new ConflictError("NEGATIVE_STOCK", `Only ${formatQuantity(free > ZERO ? free : ZERO)} ${line.product?.baseUnit ?? ""} of ${line.line.productName} can be delivered from here (the rest is on hand but set aside for other orders, or not in stock).`, { fieldErrors: { "lines.0.quantity": "Not enough stock." } });
      }

      // 3. The challan, the stock leaving (once), the reservation used up, the journal and the audit row.
      const { fy, number } = await takeDocumentNumber(tx, session.shopId, "DC");
      const challanId = randomUUID();
      const today = indiaDate();
      await tx.insert(deliveryChallans).values({ id: challanId, shopId: session.shopId, fy, number, orderId: order.id, customerId: order.customerId, godownId, deliveryDate: today, note: data.note || null, createdBy: session.userId });
      await tx.insert(deliveryChallanLines).values(
        planned.map((line) => ({ id: randomUUID(), challanId, orderLineId: line.line.id, productId: line.line.productId, unit: line.line.unit, factor: toDbQuantity(line.factor), qty: toDbQuantity(line.quantity), baseQty: toDbQuantity(line.base), unitCostPaise: line.product?.costPaise ?? null, productName: line.line.productName })),
      );
      for (const line of planned) {
        await appendStockMovement(tx, { shopId: session.shopId, productId: line.line.productId, godownId, movementDate: today, kind: "delivery", qtyBase: -line.base, unitCostPaise: line.product?.costPaise ?? null, sourceType: "delivery_challan", sourceId: challanId, reason: number, entered: { qty: toDbQuantity(line.quantity), unit: line.line.unit, factor: toDbQuantity(line.factor) }, createdBy: session.userId });
        const mine = own.get(line.line.id);
        if (mine && mine.godownId === godownId) await consumeReservation(tx, session.shopId, line.line.id, line.base);
      }
      await postDelivery(tx, booksOf(session), { challanId, date: today, lines: planned.map((line) => ({ productId: line.line.productId, qtyBase: formatQuantity(line.base), unitCostPaise: line.product?.costPaise ?? null })) });
      const status = await refreshStatus(tx, session.shopId, order.id);
      await recordAudit(tx, actorOf(session), { action: "sales.delivery_created", entityType: "delivery_challan", entityId: challanId, after: { number, orderId: order.id, godownId, orderStatus: status, lines: planned.map((line) => ({ productId: line.line.productId, qtyBase: formatQuantity(line.base) })) } });
      return { status: 201, body: { id: challanId, number } };
    });
    return { ...outcome.body, replayed: outcome.replayed };
  });
}

/** Cancels a delivery nothing has been billed against: the stock goes back into the godown it left and the books are reversed. Billed goods are never reversed here. */
export async function cancelDeliveryChallan(session: SessionContext, challanId: string, input: unknown): Promise<void> {
  await requirePermission(session, INVOICE_CANCEL);
  const { reason } = reasonSchema.parse(input);
  if (!UUID.test(challanId)) throw new NotFoundError("Delivery not found.");
  await withTransaction(async (tx) => {
    const [found] = await tx.select({ orderId: deliveryChallans.orderId }).from(deliveryChallans).where(and(eq(deliveryChallans.id, challanId), eq(deliveryChallans.shopId, session.shopId))).limit(1);
    if (!found) throw new NotFoundError("Delivery not found.");
    await loadOrder(tx, session.shopId, found.orderId, true);
    const [challan] = await tx.select().from(deliveryChallans).where(eq(deliveryChallans.id, challanId)).limit(1).for("update");
    if (!challan || challan.status === "cancelled") throw new ConflictError("ALREADY_CANCELLED", "This delivery is already cancelled.");
    const lines = await tx.select().from(deliveryChallanLines).where(eq(deliveryChallanLines.challanId, challan.id)).orderBy(asc(deliveryChallanLines.productId));
    const billed = await tx.select({ id: invoiceChallanLinks.id }).from(invoiceChallanLinks).where(and(inArray(invoiceChallanLinks.challanLineId, lines.map((line) => line.id)), sql`${invoiceChallanLinks.releasedAt} is null`)).limit(1);
    if (billed.length > 0) throw new ConflictError("CHALLAN_BILLED", "Some of these goods were already billed, so the delivery can't be cancelled. Cancel the bill first.");
    await lockProductsForStock(tx, session.shopId, lines.map((line) => line.productId));
    const leftFrom = await originalGodowns(tx, session.shopId, "delivery_challan", challan.id);
    await lockStockRows(tx, session.shopId, lines.map((line) => line.productId));
    const today = indiaDate();
    await tx.update(deliveryChallans).set({ status: "cancelled", cancelledAt: new Date(), cancelReason: reason }).where(eq(deliveryChallans.id, challan.id));
    for (const line of lines) {
      await appendStockMovement(tx, { shopId: session.shopId, productId: line.productId, godownId: leftFrom.get(line.productId) ?? challan.godownId, movementDate: today, kind: "delivery_cancel", qtyBase: parseQuantity(line.baseQty), unitCostPaise: line.unitCostPaise, sourceType: "delivery_challan", sourceId: challan.id, reason: `Cancelled ${challan.number}: ${reason}`, entered: { qty: line.qty, unit: line.unit, factor: line.factor }, createdBy: session.userId });
    }
    await postDeliveryCancelled(tx, booksOf(session), { challanId: challan.id, date: today });
    const status = await refreshStatus(tx, session.shopId, challan.orderId);
    await recordAudit(tx, actorOf(session), { action: "sales.delivery_cancelled", entityType: "delivery_challan", entityId: challan.id, before: { status: "delivered" }, after: { status: "cancelled", orderStatus: status }, reason });
  });
}

export type SalesOrderListRow = { id: string; number: string; customerName: string; status: Status; orderDate: string; expectedDate: string | null; lines: number };

export async function listSalesOrders(session: SessionContext, filters: { status?: string } = {}): Promise<SalesOrderListRow[]> {
  await requirePermission(session, BILLING_VIEW);
  const rows = await getDb().execute<{ id: string; number: string; name: string; status: Status; order_date: string; expected_date: string | null; lines: string }>(sql`
    select o.id, o.number, c.name, o.status, o.order_date::text as order_date, o.expected_date::text as expected_date,
           (select count(*) from sales_order_lines l where l.order_id = o.id) as lines
    from sales_orders o join customers c on c.id = o.customer_id
    where o.shop_id = ${session.shopId} and (${filters.status ?? null}::text is null or o.status = ${filters.status ?? null})
    order by o.created_at desc limit 100`);
  return rows.rows.map((row) => ({ id: row.id, number: row.number, customerName: row.name, status: row.status, orderDate: row.order_date, expectedDate: row.expected_date, lines: Number(row.lines) }));
}

/** An order with, per line, ordered, reserved, delivered, billed and still pending, plus its deliveries and bills. */
export async function getSalesOrder(session: SessionContext, orderId: string) {
  await requirePermission(session, BILLING_VIEW);
  const db = getDb();
  const order = await loadOrder(db, session.shopId, orderId);
  const [lines, held, { delivered, billed }, customer, challans, places, users, shop, canCancelChallan, canCreate] = await Promise.all([
    db.select().from(salesOrderLines).where(eq(salesOrderLines.orderId, order.id)).orderBy(asc(salesOrderLines.lineNo)),
    reservationsForOrder(session.shopId, order.id, db),
    progress(db, session.shopId, order.id),
    findCustomer(session.shopId, order.customerId, db),
    db.select().from(deliveryChallans).where(eq(deliveryChallans.orderId, order.id)).orderBy(desc(deliveryChallans.createdAt)),
    godownList(db, session.shopId),
    loadUserNames(session.shopId, [order.createdBy]),
    getCurrentShop(session),
    hasPermission(session, INVOICE_CANCEL),
    hasPermission(session, BILLING_CREATE),
  ]);
  const billsRows = await db.execute<{ id: string; number: string; total: string; status: string }>(sql`
    select distinct i.id, i.number, i.total_paise::text as total, i.status from invoice_challan_links k join invoices i on i.id = k.invoice_id
    join delivery_challan_lines l on l.id = k.challan_line_id join delivery_challans c on c.id = l.challan_id
    where c.order_id = ${order.id} and c.shop_id = ${session.shopId}`);
  const lineViews: OrderLineView[] = lines.map((line) => {
    const ordered = parseQuantity(line.baseQty);
    const done = delivered.get(line.id) ?? ZERO;
    const reserved = held.get(line.id)?.qty ?? ZERO;
    const pending = order.closedAt ? ZERO : ordered - done;
    const short = pending - reserved;
    return {
      id: line.id,
      lineNo: line.lineNo,
      productId: line.productId,
      productName: line.productName,
      unit: line.unit,
      factor: formatQuantity(parseQuantity(line.factor)),
      orderedQty: formatQuantity(parseQuantity(line.qty)),
      orderedBase: formatQuantity(ordered),
      reservedBase: formatQuantity(reserved),
      deliveredBase: formatQuantity(done),
      billedBase: formatQuantity(billed.get(line.id) ?? ZERO),
      pendingBase: formatQuantity(pending > ZERO ? pending : ZERO),
      shortBase: formatQuantity(short > ZERO && order.status !== "draft" && order.status !== "cancelled" ? short : ZERO),
      indicativeRatePaise: line.indicativeRatePaise,
    };
  });
  const challanLines = challans.length ? await db.select().from(deliveryChallanLines).where(inArray(deliveryChallanLines.challanId, challans.map((challan) => challan.id))) : [];
  const links = challanLines.length ? await db.select().from(invoiceChallanLinks).where(and(inArray(invoiceChallanLinks.challanLineId, challanLines.map((line) => line.id)), sql`${invoiceChallanLinks.releasedAt} is null`)) : [];
  const billedByChallanLine = new Map<string, Milli>();
  for (const link of links) billedByChallanLine.set(link.challanLineId, (billedByChallanLine.get(link.challanLineId) ?? ZERO) + parseQuantity(link.baseQty));
  return {
    ...order,
    shop,
    customer: { id: customer.id, name: customer.name, phone: customer.phone },
    godownName: places.find((place) => place.id === order.godownId)?.name ?? null,
    createdByName: users.get(order.createdBy) ?? "Unknown user",
    lines: lineViews,
    challans: challans.map((challan) => {
      const own = challanLines.filter((line) => line.challanId === challan.id);
      return {
        id: challan.id,
        number: challan.number,
        status: challan.status,
        deliveryDate: challan.deliveryDate,
        godownName: places.find((place) => place.id === challan.godownId)?.name ?? "",
        lines: own.map((line) => ({ id: line.id, productName: line.productName, unit: line.unit, qty: formatQuantity(parseQuantity(line.qty)), baseQty: formatQuantity(parseQuantity(line.baseQty)), billedBase: formatQuantity(billedByChallanLine.get(line.id) ?? ZERO) })),
        billed: own.some((line) => (billedByChallanLine.get(line.id) ?? ZERO) > ZERO),
      };
    }),
    bills: billsRows.rows.map((row) => ({ id: row.id, number: row.number, totalPaise: Number(row.total), status: row.status })),
    manyGodowns: places.length > 1,
    godowns: places.map((place) => ({ id: place.id, name: place.name, isDefault: place.isDefault })),
    canCancelChallan,
    canCreate,
    unbilledDeliveredBase: formatQuantity(lineViews.reduce((sum, line) => sum + (parseQuantity(line.deliveredBase) - parseQuantity(line.billedBase)), ZERO)),
  };
}

/** A delivery challan to print: the customer, the order, what left, from which godown, in the unit it was ordered in. */
export async function getDeliveryChallan(session: SessionContext, challanId: string) {
  await requirePermission(session, BILLING_VIEW);
  if (!UUID.test(challanId)) throw new NotFoundError("Delivery not found.");
  const db = getDb();
  const [challan] = await db.select().from(deliveryChallans).where(and(eq(deliveryChallans.id, challanId), eq(deliveryChallans.shopId, session.shopId))).limit(1);
  if (!challan) throw new NotFoundError("Delivery not found.");
  const [lines, order, customer, shop, places, users] = await Promise.all([
    db.select().from(deliveryChallanLines).where(eq(deliveryChallanLines.challanId, challan.id)),
    db.select({ id: salesOrders.id, number: salesOrders.number }).from(salesOrders).where(eq(salesOrders.id, challan.orderId)).then((rows) => rows[0]!),
    findCustomer(session.shopId, challan.customerId, db),
    getCurrentShop(session),
    godownList(db, session.shopId, { includeInactive: true }),
    loadUserNames(session.shopId, [challan.createdBy]),
  ]);
  return {
    ...challan,
    shop,
    order,
    customer: { id: customer.id, name: customer.name, phone: customer.phone, area: customer.area },
    godownName: places.find((place) => place.id === challan.godownId)?.name ?? "",
    createdByName: users.get(challan.createdBy) ?? "Unknown user",
    lines: lines.map((line) => ({ id: line.id, productName: line.productName, unit: line.unit, qty: formatQuantity(parseQuantity(line.qty)), baseQty: formatQuantity(parseQuantity(line.baseQty)) })),
  };
}

export type OrderBillable = { productId: string; challanLineId: string; challanNumber: string; orderLineId: string; productName: string; unit: string; deliveredQty: string; billedQty: string; remainingQty: string; indicativeRatePaise: number };

/** What was delivered on an order and not yet billed, in each line's own unit, with the order's indicative rate for comparison. */
export async function listBillableDeliveries(session: SessionContext, orderId: string): Promise<{ customerId: string; customerName: string; orderNumber: string; lines: OrderBillable[] }> {
  await requirePermission(session, BILLING_CREATE);
  const db = getDb();
  const order = await loadOrder(db, session.shopId, orderId);
  const customer = await findCustomer(session.shopId, order.customerId, db);
  const rows = await db.execute<{ id: string; number: string; order_line_id: string; product_id: string; name: string; unit: string; factor: string; qty: string; base: string; billed: string; rate: string }>(sql`
    select l.id, c.number, l.order_line_id, l.product_id, l.product_name as name, l.unit, l.factor::text, l.qty::text, l.base_qty::text as base,
           coalesce((select sum(k.base_qty) from invoice_challan_links k where k.challan_line_id = l.id and k.released_at is null), 0)::text as billed,
           ol.indicative_rate_paise::text as rate
    from delivery_challan_lines l join delivery_challans c on c.id = l.challan_id join sales_order_lines ol on ol.id = l.order_line_id
    where c.shop_id = ${session.shopId} and c.order_id = ${order.id} and c.status = 'delivered' order by c.created_at, l.product_name`);
  const lines: OrderBillable[] = [];
  for (const row of rows.rows) {
    const factor = parseQuantity(row.factor);
    const remainingBase = parseQuantity(row.base) - parseQuantity(row.billed);
    if (remainingBase <= ZERO) continue;
    lines.push({ productId: row.product_id, challanLineId: row.id, challanNumber: row.number, orderLineId: row.order_line_id, productName: row.name, unit: row.unit, deliveredQty: formatQuantity(parseQuantity(row.qty)), billedQty: formatQuantity(factor === ZERO ? ZERO : (parseQuantity(row.billed) * BigInt(1000)) / factor), remainingQty: formatQuantity(factor === ZERO ? ZERO : (remainingBase * BigInt(1000)) / factor), indicativeRatePaise: Number(row.rate) });
  }
  return { customerId: customer.id, customerName: customer.name, orderNumber: order.number, lines };
}
