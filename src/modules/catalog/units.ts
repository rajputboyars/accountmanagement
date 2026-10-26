import { and, asc, count, eq, sql } from "drizzle-orm";
import { recordAudit } from "@/modules/audit";
import { requirePermission, type SessionContext } from "@/modules/identity";
import { getDb, withTransaction, type Transaction } from "@/server/db";
import { isUniqueViolation } from "@/server/db-errors";
import { ConflictError, NotFoundError } from "@/server/errors";
import { CATALOG_MANAGE, CATALOG_VIEW } from "./permissions";
import { products, units } from "./schema";
import { unitCodeSchema, unitInputSchema } from "./validation";

/** Common units every new shop starts with. Packaging sizes are NOT defined here: they are per product. */
export const DEFAULT_UNITS = [
  { code: "pc", name: "Piece", allowDecimal: false },
  { code: "box", name: "Box", allowDecimal: false },
  { code: "bundle", name: "Bundle", allowDecimal: false },
  { code: "m", name: "Meter", allowDecimal: true },
  { code: "length", name: "Length", allowDecimal: false },
  { code: "kg", name: "Kilogram", allowDecimal: true },
  { code: "bag", name: "Bag", allowDecimal: false },
  { code: "ltr", name: "Litre", allowDecimal: true },
  { code: "set", name: "Set", allowDecimal: false },
] as const;

export type Unit = { id: string; code: string; name: string; allowDecimal: boolean; isActive: boolean; productCount: number };

/** Inside first-run setup's transaction. Safe to call twice. */
export async function seedDefaultUnits(tx: Transaction, shopId: string): Promise<void> {
  await tx
    .insert(units)
    .values(DEFAULT_UNITS.map((unit) => ({ shopId, ...unit })))
    .onConflictDoNothing();
}

export async function listUnits(session: SessionContext, options: { includeInactive?: boolean } = {}): Promise<Unit[]> {
  await requirePermission(session, CATALOG_VIEW);
  const productCount = sql<number>`(select count(*)::int from ${products} where ${products.shopId} = ${units.shopId} and ${products.baseUnit} = ${units.code})`;
  const rows = await getDb()
    .select({ id: units.id, code: units.code, name: units.name, allowDecimal: units.allowDecimal, isActive: units.isActive, productCount })
    .from(units)
    .where(options.includeInactive ? eq(units.shopId, session.shopId) : and(eq(units.shopId, session.shopId), eq(units.isActive, true)))
    .orderBy(asc(units.name));
  return rows;
}

export async function createUnit(session: SessionContext, input: unknown): Promise<Unit> {
  await requirePermission(session, CATALOG_MANAGE);
  const data = unitInputSchema.parse(input);
  return withTransaction(async (tx) => {
    const [sameName] = await tx
      .select({ n: count() })
      .from(units)
      .where(and(eq(units.shopId, session.shopId), sql`lower(${units.name}) = lower(${data.name})`));
    if ((sameName?.n ?? 0) > 0) throw new ConflictError("UNIT_NAME_IN_USE", `There is already a unit called "${data.name}".`);
    try {
      const [row] = await tx
        .insert(units)
        .values({ shopId: session.shopId, ...data })
        .returning({ id: units.id, code: units.code, name: units.name, allowDecimal: units.allowDecimal, isActive: units.isActive });
      await recordAudit(tx, { shopId: session.shopId, userId: session.userId, role: session.role }, {
        action: "catalog.unit_created",
        entityType: "unit",
        entityId: row!.id,
        after: data,
      });
      return { ...row!, productCount: 0 };
    } catch (error) {
      if (isUniqueViolation(error, "units_shop_code_key")) {
        throw new ConflictError("UNIT_CODE_IN_USE", `The short name "${data.code}" is already used by another unit.`);
      }
      throw error;
    }
  });
}

/**
 * Deactivating hides a unit from new products and packaging. Products that already use it keep it,
 * so nothing that may appear on a bill is removed.
 */
export async function setUnitActive(session: SessionContext, code: string, active: boolean): Promise<void> {
  await requirePermission(session, CATALOG_MANAGE);
  const unitCode = unitCodeSchema.parse(code);
  await withTransaction(async (tx) => {
    const [row] = await tx
      .update(units)
      .set({ isActive: active })
      .where(and(eq(units.shopId, session.shopId), eq(units.code, unitCode)))
      .returning({ id: units.id });
    if (!row) throw new NotFoundError("Unit not found.");
    await recordAudit(tx, { shopId: session.shopId, userId: session.userId, role: session.role }, {
      action: active ? "catalog.unit_activated" : "catalog.unit_deactivated",
      entityType: "unit",
      entityId: row.id,
    });
  });
}

/** An active unit of this shop, or a clear error. */
export async function requireActiveUnit(tx: Transaction, shopId: string, code: string, purpose: string) {
  const [unit] = await tx
    .select({ code: units.code, name: units.name, allowDecimal: units.allowDecimal, isActive: units.isActive })
    .from(units)
    .where(and(eq(units.shopId, shopId), eq(units.code, code)))
    .limit(1);
  if (!unit) throw new NotFoundError(`Choose a ${purpose} from your unit list.`);
  if (!unit.isActive) throw new ConflictError("UNIT_INACTIVE", `"${unit.name}" is switched off. Turn it back on in Units, or choose another.`);
  return unit;
}
