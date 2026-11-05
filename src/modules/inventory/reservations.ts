import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database, Transaction } from "@/server/db";
import { getDb } from "@/server/db";
import { parseQuantity, toDbQuantity, type Milli } from "@/shared/quantity";
import { ledgerTotals, signedQuantity } from "./ledger";
import { stockReservations } from "./schema";

/**
 * Reserved versus physical stock. A reservation sets stock aside for a confirmed order without moving it. What a godown can
 * give to a new sale, a transfer, an adjustment or a return is: physical stock in it minus the reservations on it.
 * Reservations are only changed with the godown's stock rows locked, so two writers never both claim the same units.
 */

type Db = Database | Transaction;

/** Reserved quantity per product, in one godown or across the shop, optionally leaving out one order line's own reservation. */
export async function reservedQuantities(db: Db, shopId: string, productIds: string[], options: { godownId?: string; excludeOrderLineId?: string } = {}): Promise<Map<string, Milli>> {
  if (productIds.length === 0) return new Map();
  const rows = await db
    .select({ productId: stockReservations.productId, qty: sql<string>`sum(${stockReservations.qtyBase})::text` })
    .from(stockReservations)
    .where(
      and(
        eq(stockReservations.shopId, shopId),
        inArray(stockReservations.productId, productIds),
        options.godownId ? eq(stockReservations.godownId, options.godownId) : undefined,
        options.excludeOrderLineId ? sql`${stockReservations.orderLineId} <> ${options.excludeOrderLineId}` : undefined,
      ),
    )
    .groupBy(stockReservations.productId);
  return new Map(rows.map((row) => [row.productId, parseQuantity(row.qty)]));
}

export type Availability = { onHand: Milli; reserved: Milli; available: Milli };

/** Physical, reserved and available stock per product (for one godown when given). Available can be negative only if data was edited by hand. */
export async function availableStock(db: Db, shopId: string, productIds: string[], options: { godownId?: string; excludeOrderLineId?: string } = {}): Promise<Map<string, Availability>> {
  const [stock, reserved] = await Promise.all([ledgerTotals(shopId, productIds, db, options.godownId ? { godownId: options.godownId } : {}), reservedQuantities(db, shopId, productIds, options)]);
  const result = new Map<string, Availability>();
  for (const id of productIds) {
    const onHand = stock.get(id)?.qty ?? BigInt(0);
    const held = reserved.get(id) ?? BigInt(0);
    result.set(id, { onHand, reserved: held, available: onHand - held });
  }
  return result;
}

/** Adds to (or creates) the reservation of one order line in one godown. The caller holds the stock locks and has checked availability. */
export async function addReservation(tx: Transaction, input: { shopId: string; orderId: string; orderLineId: string; productId: string; godownId: string; qtyBase: Milli }): Promise<void> {
  if (input.qtyBase <= BigInt(0)) return;
  await tx
    .insert(stockReservations)
    .values({ shopId: input.shopId, orderId: input.orderId, orderLineId: input.orderLineId, productId: input.productId, godownId: input.godownId, qtyBase: toDbQuantity(input.qtyBase) })
    .onConflictDoUpdate({ target: stockReservations.orderLineId, set: { qtyBase: sql`${stockReservations.qtyBase} + excluded.qty_base`, updatedAt: sql`now()` } });
}

/** The reservation of an order line, locked for the rest of the transaction. */
export async function reservationOf(tx: Transaction, shopId: string, orderLineId: string): Promise<{ id: string; godownId: string; qty: Milli } | null> {
  const [row] = await tx
    .select({ id: stockReservations.id, godownId: stockReservations.godownId, qty: stockReservations.qtyBase })
    .from(stockReservations)
    .where(and(eq(stockReservations.shopId, shopId), eq(stockReservations.orderLineId, orderLineId)))
    .limit(1)
    .for("update");
  return row ? { id: row.id, godownId: row.godownId, qty: signedQuantity(row.qty) } : null;
}

/** Takes up to `qtyBase` out of an order line's reservation (a delivery uses reserved stock first). Returns how much was taken. */
export async function consumeReservation(tx: Transaction, shopId: string, orderLineId: string, qtyBase: Milli): Promise<Milli> {
  const held = await reservationOf(tx, shopId, orderLineId);
  if (!held || qtyBase <= BigInt(0)) return BigInt(0);
  const taken = held.qty < qtyBase ? held.qty : qtyBase;
  if (taken === held.qty) await tx.delete(stockReservations).where(eq(stockReservations.id, held.id));
  else await tx.update(stockReservations).set({ qtyBase: toDbQuantity(held.qty - taken), updatedAt: new Date() }).where(eq(stockReservations.id, held.id));
  return taken;
}

/** Releases every reservation of an order (cancelled or closed). */
export async function releaseOrderReservations(tx: Transaction, shopId: string, orderId: string): Promise<void> {
  await tx.delete(stockReservations).where(and(eq(stockReservations.shopId, shopId), eq(stockReservations.orderId, orderId)));
}

/** Reservations of one order, by order line. */
export async function reservationsForOrder(shopId: string, orderId: string, db: Db = getDb()): Promise<Map<string, { godownId: string; qty: Milli }>> {
  const rows = await db.select({ orderLineId: stockReservations.orderLineId, godownId: stockReservations.godownId, qty: stockReservations.qtyBase }).from(stockReservations).where(and(eq(stockReservations.shopId, shopId), eq(stockReservations.orderId, orderId)));
  return new Map(rows.map((row) => [row.orderLineId, { godownId: row.godownId, qty: signedQuantity(row.qty) }]));
}
