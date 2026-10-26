import { randomUUID } from "node:crypto";
import { recordAudit } from "@/modules/audit";
import { lockProductsForStock, type ProductStockUnits } from "@/modules/catalog";
import { requirePermission, type SessionContext } from "@/modules/identity";
import { withIdempotency } from "@/modules/sync";
import { withTransaction } from "@/server/db";
import { isUniqueViolation } from "@/server/db-errors";
import { ConflictError, ValidationError } from "@/server/errors";
import { formatQuantity, isWholeQuantity, ONE_UNIT, toBaseQuantity, type Milli } from "@/shared/quantity";
import { appendMovement, ledgerTotals, lockCacheRows } from "./ledger";
import { STOCK_OPENING } from "./permissions";
import { openingInputSchema } from "./validation";

/**
 * Go-live opening stock (spec §8): one OPENING movement per product, dated the opening day, with
 * the cost per base unit at that date. All lines are checked before anything is written and saved
 * in one transaction, so either every line is recorded or none is.
 *
 * A product that already has any stock entry can't be opened again; later changes are stock
 * adjustments. This is checked under a row lock on the product and also enforced by the database
 * (one opening movement per product). Repeating the same submission (same Idempotency-Key)
 * returns the first result instead of saving twice.
 */

export type OpeningResult = { batchId: string; lines: { productId: string; name: string; qty: string; baseUnit: string }[] };

/** Field errors keyed like "lines.2.quantity", so the form can show each next to its input. */
export class OpeningLinesError extends ValidationError {
  constructor(readonly fieldErrors: Record<string, string>) {
    super(`${Object.keys(fieldErrors).length === 1 ? "One line needs" : "Some lines need"} attention. Nothing was saved.`, { fieldErrors });
  }
}

function baseQuantityFor(product: ProductStockUnits, unit: string, quantity: Milli): { base: Milli } | { error: string; field: "unit" | "quantity" } {
  const factor = unit === product.baseUnit ? ONE_UNIT : product.saleUnits.find((candidate) => candidate.code === unit)?.factor;
  if (!factor) return { error: `${product.name} isn't sold in "${unit}". Choose ${product.baseUnit} or one of its pack sizes.`, field: "unit" };
  const base = toBaseQuantity(quantity, factor);
  if (base === null) return { error: "That quantity can't be stored exactly. Use fewer decimal places.", field: "quantity" };
  if (!product.baseAllowsDecimal && !isWholeQuantity(base)) {
    return { error: `${product.baseUnitName} can't be split, so this must come to a whole number of ${product.baseUnit} (it comes to ${formatQuantity(base)}).`, field: "quantity" };
  }
  return { base };
}

export async function recordOpeningStock(session: SessionContext, input: unknown): Promise<OpeningResult & { replayed: boolean }> {
  await requirePermission(session, STOCK_OPENING);
  const data = openingInputSchema.parse(input);
  const { idempotencyKey, ...body } = data;
  try {
    return await withTransaction(async (tx) => {
      const outcome = await withIdempotency<OpeningResult>(tx, { shopId: session.shopId, userId: session.userId, key: idempotencyKey }, { action: "inventory.opening", ...body, lines: body.lines.map((line) => ({ ...line, quantity: line.quantity.toString() })) }, async () => {
        const productIds = body.lines.map((line) => line.productId);
        const products = new Map((await lockProductsForStock(tx, session.shopId, productIds)).map((product) => [product.id, product]));
        await lockCacheRows(tx, session.shopId, productIds);
        const existing = await ledgerTotals(session.shopId, productIds, tx);

        const errors: Record<string, string> = {};
        const planned: { product: ProductStockUnits; base: Milli; unitCost: number | null }[] = [];
        body.lines.forEach((line, index) => {
          const product = products.get(line.productId);
          if (!product) {
            errors[`lines.${index}.productId`] = "Product not found.";
            return;
          }
          if (!product.isActive) {
            errors[`lines.${index}.productId`] = `${product.name} is switched off. Switch it on first.`;
            return;
          }
          if (existing.has(product.id)) {
            errors[`lines.${index}.productId`] = `${product.name} already has stock entries. Use a stock adjustment (count fix) to change it.`;
            return;
          }
          const result = baseQuantityFor(product, line.unit, line.quantity);
          if ("error" in result) {
            errors[`lines.${index}.${result.field}`] = result.error;
            return;
          }
          planned.push({ product, base: result.base, unitCost: line.unitCost ?? product.costPaise });
        });
        if (Object.keys(errors).length > 0) throw new OpeningLinesError(errors);

        const batchId = randomUUID();
        for (const line of planned) {
          await appendMovement(tx, {
            shopId: session.shopId,
            productId: line.product.id,
            movementDate: body.movementDate,
            kind: "opening",
            qtyBase: line.base,
            unitCostPaise: line.unitCost,
            sourceType: "opening_stock",
            sourceId: batchId,
            reason: body.note || "Opening stock",
            createdBy: session.userId,
          });
        }
        const lines = planned.map((line) => ({ productId: line.product.id, name: line.product.name, qty: formatQuantity(line.base), baseUnit: line.product.baseUnit }));
        await recordAudit(tx, { shopId: session.shopId, userId: session.userId, role: session.role }, {
          action: "inventory.opening_recorded",
          entityType: "opening_stock",
          entityId: batchId,
          after: {
            movementDate: body.movementDate,
            note: body.note || null,
            lines: planned.map((line) => ({ productId: line.product.id, qtyBase: formatQuantity(line.base), unitCostPaise: line.unitCost })),
          },
        });
        return { status: 201, body: { batchId, lines } };
      });
      return { ...outcome.body, replayed: outcome.replayed };
    });
  } catch (error) {
    // The product lock makes this unreachable in practice; the index is the last line of defence.
    if (isUniqueViolation(error, "stock_movements_one_opening_key")) {
      throw new ConflictError("OPENING_EXISTS", "Opening stock was already entered for one of these products. Use a stock adjustment instead.");
    }
    throw error;
  }
}
