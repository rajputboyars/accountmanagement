import { and, eq } from "drizzle-orm";
import { recordAudit } from "@/modules/audit";
import { requirePermission, type SessionContext } from "@/modules/identity";
import { withTransaction, type Transaction } from "@/server/db";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import { formatQuantity, isWholeQuantity, ONE_UNIT, toDbQuantity, type Milli } from "@/shared/quantity";
import { CATALOG_MANAGE } from "./permissions";
import { productUnits, products, units } from "./schema";
import { requireActiveUnit } from "./units";
import { conversionFactorSchema, productUnitInputSchema } from "./validation";

const actorOf = (session: SessionContext) => ({ shopId: session.shopId, userId: session.userId, role: session.role });

/** Locks the product row (so concurrent packaging edits run one at a time) and returns it with its base unit. */
async function lockProduct(tx: Transaction, shopId: string, productId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(productId)) throw new NotFoundError("Product not found.");
  const [product] = await tx
    .select({ id: products.id, baseUnit: products.baseUnit, baseUnitName: units.name, baseAllowsDecimal: units.allowDecimal })
    .from(products)
    .innerJoin(units, and(eq(units.shopId, products.shopId), eq(units.code, products.baseUnit)))
    .where(and(eq(products.id, productId), eq(products.shopId, shopId)))
    .limit(1)
    .for("update", { of: products });
  if (!product) throw new NotFoundError("Product not found.");
  return product;
}

/**
 * A packaging size is "1 <unit> = factor × base unit". Rules:
 * more than 0; not exactly 1 (that would just be the base unit again); at most 3 decimals;
 * a whole number when the base unit can't be split (a box can't hold 2.5 pieces).
 */
function validateFactor(factor: Milli, base: { baseUnitName: string; baseAllowsDecimal: boolean }): void {
  if (factor <= BigInt(0)) throw new ValidationError("The amount must be more than 0.");
  if (factor === ONE_UNIT) throw new ValidationError(`One of this unit would equal one ${base.baseUnitName}. You don't need a separate unit for that.`);
  if (!base.baseAllowsDecimal && !isWholeQuantity(factor)) {
    throw new ValidationError(`${base.baseUnitName} can't be split, so enter a whole number (for example 50, not ${formatQuantity(factor)}).`);
  }
}

export async function addProductUnit(session: SessionContext, productId: string, input: unknown): Promise<{ id: string }> {
  await requirePermission(session, CATALOG_MANAGE);
  const data = productUnitInputSchema.parse(input);
  return withTransaction(async (tx) => {
    const product = await lockProduct(tx, session.shopId, productId);
    if (data.unit === product.baseUnit) {
      throw new ValidationError(`${product.baseUnitName} is already this product's base unit. Choose a pack unit such as Box or Bundle.`);
    }
    const unit = await requireActiveUnit(tx, session.shopId, data.unit, "pack unit");
    validateFactor(data.factor, product);

    const [existing] = await tx
      .select({ id: productUnits.id, isActive: productUnits.isActive })
      .from(productUnits)
      .where(and(eq(productUnits.productId, product.id), eq(productUnits.unit, data.unit)))
      .limit(1);
    if (existing?.isActive) {
      throw new ConflictError("PACKAGING_EXISTS", `${unit.name} is already set up for this product. Change its size instead of adding it again.`);
    }

    const factor = toDbQuantity(data.factor);
    let id: string;
    if (existing) {
      await tx.update(productUnits).set({ factor, isActive: true }).where(eq(productUnits.id, existing.id));
      id = existing.id;
    } else {
      const [row] = await tx.insert(productUnits).values({ productId: product.id, unit: data.unit, factor }).returning({ id: productUnits.id });
      id = row!.id;
    }
    await recordAudit(tx, actorOf(session), {
      action: existing ? "catalog.packaging_reactivated" : "catalog.packaging_added",
      entityType: "product",
      entityId: product.id,
      after: { unit: data.unit, factor: formatQuantity(data.factor), baseUnit: product.baseUnit },
    });
    return { id };
  });
}

async function findPackaging(tx: Transaction, productId: string, packagingId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(packagingId)) throw new NotFoundError("Pack size not found.");
  const [row] = await tx
    .select({ id: productUnits.id, unit: productUnits.unit, factor: productUnits.factor, isActive: productUnits.isActive })
    .from(productUnits)
    .where(and(eq(productUnits.id, packagingId), eq(productUnits.productId, productId)))
    .limit(1);
  if (!row) throw new NotFoundError("Pack size not found.");
  return row;
}

/** Changes how many base units one packaging unit holds. Past bills keep the factor they were made with. */
export async function updateProductUnitFactor(session: SessionContext, productId: string, packagingId: string, factorInput: unknown): Promise<void> {
  await requirePermission(session, CATALOG_MANAGE);
  const factor = conversionFactorSchema.parse(factorInput);
  await withTransaction(async (tx) => {
    const product = await lockProduct(tx, session.shopId, productId);
    const packaging = await findPackaging(tx, product.id, packagingId);
    validateFactor(factor, product);
    await tx.update(productUnits).set({ factor: toDbQuantity(factor) }).where(eq(productUnits.id, packaging.id));
    await recordAudit(tx, actorOf(session), {
      action: "catalog.packaging_changed",
      entityType: "product",
      entityId: product.id,
      before: { unit: packaging.unit, factor: packaging.factor },
      after: { unit: packaging.unit, factor: toDbQuantity(factor) },
    });
  });
}

/** Retires or restores a packaging unit. Retired ones stay on record for past bills. */
export async function setProductUnitActive(session: SessionContext, productId: string, packagingId: string, active: boolean): Promise<void> {
  await requirePermission(session, CATALOG_MANAGE);
  await withTransaction(async (tx) => {
    const product = await lockProduct(tx, session.shopId, productId);
    const packaging = await findPackaging(tx, product.id, packagingId);
    if (active) await requireActiveUnit(tx, session.shopId, packaging.unit, "pack unit");
    await tx.update(productUnits).set({ isActive: active }).where(eq(productUnits.id, packaging.id));
    await recordAudit(tx, actorOf(session), {
      action: active ? "catalog.packaging_reactivated" : "catalog.packaging_retired",
      entityType: "product",
      entityId: product.id,
      after: { unit: packaging.unit },
    });
  });
}
