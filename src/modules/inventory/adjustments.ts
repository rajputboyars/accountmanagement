import { and, desc, eq } from "drizzle-orm";
import { recordAudit } from "@/modules/audit";
import { lockProductsForStock } from "@/modules/catalog";
import { requirePermission, type SessionContext } from "@/modules/identity";
import { takeDocumentNumber } from "@/modules/settings";
import { withIdempotency } from "@/modules/sync";
import { getDb, withTransaction } from "@/server/db";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import { indiaDate } from "@/shared/financial-year";
import { formatPaise } from "@/shared/money";
import { multiplyQuantity } from "@/shared/pricing-engine";
import { formatQuantity, isWholeQuantity, ONE_UNIT, toBaseQuantity, type Milli } from "@/shared/quantity";
import { appendMovement, ledgerTotals, lockCacheRows, signedQuantity } from "./ledger";
import { OWNER_APPROVAL_THRESHOLD_PAISE, STOCK_ADJUST, STOCK_VIEW } from "./permissions";
import { stockAdjustments, stockMovements } from "./schema";
import { adjustmentInputSchema } from "./validation";

/**
 * Stock adjustments (spec §5, scenario S3): customer return (+), damaged (−) or stock count fix
 * (+ or −). A reason is required, stock can never go below zero (decision 12), and each one gets
 * an ADJ number, one append-only movement, the cache update and an audit row in one transaction.
 *
 * An adjustment worth more than ₹2,000 at cost needs the owner (decision 21). The owner-approval
 * flow (PIN on another user's request) arrives with the approvals phase; until then staff are
 * told to ask the owner, who can record it directly. A product with no cost price can't be valued,
 * so staff adjustments of it also need the owner.
 */

export type AdjustmentResult = { id: string; number: string; productId: string; qtyChange: string; newQty: string; baseUnit: string };

const KIND_LABEL = { return_in: "Customer return", damage: "Damaged", count: "Stock count fix" } as const;

export async function recordAdjustment(session: SessionContext, input: unknown): Promise<AdjustmentResult & { replayed: boolean }> {
  await requirePermission(session, STOCK_ADJUST);
  const data = adjustmentInputSchema.parse(input);
  const { idempotencyKey, ...body } = data;
  return withTransaction(async (tx) => {
    const outcome = await withIdempotency<AdjustmentResult>(tx, { shopId: session.shopId, userId: session.userId, key: idempotencyKey }, { action: "inventory.adjustment", ...body, quantity: body.quantity.toString() }, async () => {
      const [product] = await lockProductsForStock(tx, session.shopId, [body.productId]);
      if (!product) throw new NotFoundError("Product not found.");
      await lockCacheRows(tx, session.shopId, [product.id]);

      const factor = body.unit === product.baseUnit ? ONE_UNIT : product.saleUnits.find((unit) => unit.code === body.unit)?.factor;
      if (!factor) throw new ValidationError(`${product.name} isn't sold in "${body.unit}".`, { fieldErrors: { unit: "Choose one of this product's units." } });
      const base = toBaseQuantity(body.quantity, factor);
      if (base === null) throw new ValidationError("That quantity can't be stored exactly. Use fewer decimal places.", { fieldErrors: { quantity: "Use fewer decimal places." } });
      if (!product.baseAllowsDecimal && !isWholeQuantity(base)) {
        throw new ValidationError(`${product.baseUnitName} can't be split, so this must come to a whole number of ${product.baseUnit}.`, { fieldErrors: { quantity: "Must be a whole number of pieces." } });
      }

      const ledger = (await ledgerTotals(session.shopId, [product.id], tx)).get(product.id);
      if (!ledger) throw new ConflictError("NO_OPENING_STOCK", `Enter opening stock for ${product.name} first.`);
      const sign = body.kind === "damage" || (body.kind === "count" && body.direction === "out") ? BigInt(-1) : BigInt(1);
      const change: Milli = base * sign;
      const newQty = ledger.qty + change;
      if (newQty < BigInt(0)) {
        throw new ConflictError("NEGATIVE_STOCK", `Stock can't go below zero: only ${formatQuantity(ledger.qty)} ${product.baseUnit} in stock.`, { available: formatQuantity(ledger.qty) });
      }

      const valuePaise = product.costPaise === null ? null : multiplyQuantity(base, product.costPaise);
      if (session.role !== "owner" && (valuePaise === null || valuePaise > OWNER_APPROVAL_THRESHOLD_PAISE)) {
        throw new ConflictError(
          "OWNER_APPROVAL_REQUIRED",
          valuePaise === null
            ? `${product.name} has no cost price, so this adjustment needs the owner. Ask the owner to record it.`
            : `This adjustment is worth ${formatPaise(valuePaise, { withPaise: true })} at cost, more than ₹2,000, so it needs the owner. Ask the owner to record it.`,
        );
      }

      const { fy, number } = await takeDocumentNumber(tx, session.shopId, "ADJ");
      const [adjustment] = await tx
        .insert(stockAdjustments)
        .values({ shopId: session.shopId, fy, number, kind: body.kind, reason: body.reason, createdBy: session.userId })
        .returning({ id: stockAdjustments.id });
      await appendMovement(tx, {
        shopId: session.shopId,
        productId: product.id,
        movementDate: indiaDate(),
        kind: body.kind,
        qtyBase: change,
        unitCostPaise: product.costPaise,
        sourceType: "stock_adjustment",
        sourceId: adjustment!.id,
        reason: body.reason,
        createdBy: session.userId,
      });
      const result: AdjustmentResult = { id: adjustment!.id, number, productId: product.id, qtyChange: formatQuantity(change), newQty: formatQuantity(newQty), baseUnit: product.baseUnit };
      await recordAudit(tx, { shopId: session.shopId, userId: session.userId, role: session.role }, {
        action: "inventory.adjustment_recorded",
        entityType: "stock_adjustment",
        entityId: adjustment!.id,
        before: { qty: formatQuantity(ledger.qty) },
        after: { number, kind: body.kind, productId: product.id, qtyChange: result.qtyChange, qty: result.newQty, reason: body.reason, valueAtCostPaise: valuePaise },
        reason: body.reason,
      });
      return { status: 201, body: result };
    });
    return { ...outcome.body, replayed: outcome.replayed };
  });
}

export type AdjustmentView = { id: string; number: string; kind: string; kindLabel: string; reason: string; createdAt: Date; productId: string | null; qtyChange: string | null };

/** Recent adjustments of the shop, newest first, with the product each one moved. */
export async function listAdjustments(session: SessionContext, limit = 50): Promise<AdjustmentView[]> {
  await requirePermission(session, STOCK_VIEW);
  const rows = await getDb()
    .select({
      id: stockAdjustments.id,
      number: stockAdjustments.number,
      kind: stockAdjustments.kind,
      reason: stockAdjustments.reason,
      createdAt: stockAdjustments.createdAt,
      productId: stockMovements.productId,
      qty: stockMovements.qtyBase,
    })
    .from(stockAdjustments)
    .leftJoin(stockMovements, and(eq(stockMovements.sourceType, "stock_adjustment"), eq(stockMovements.sourceId, stockAdjustments.id)))
    .where(eq(stockAdjustments.shopId, session.shopId))
    .orderBy(desc(stockAdjustments.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows.map(({ qty, ...row }) => ({ ...row, kindLabel: KIND_LABEL[row.kind], qtyChange: qty ? formatQuantity(signedQuantity(qty)) : null }));
}
