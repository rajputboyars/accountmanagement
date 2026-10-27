import { and, desc, eq, lt } from "drizzle-orm";
import { recordAudit } from "@/modules/audit";
import { listShopProductsForStock, loadProductsForStock, lockProductsForStock, type ProductStockInputs } from "@/modules/catalog";
import { hasPermission, loadUserNames, requirePermission, type SessionContext } from "@/modules/identity";
import { getDb, withTransaction } from "@/server/db";
import { NotFoundError } from "@/server/errors";
import { formatQuantity, toDbQuantity, type Milli } from "@/shared/quantity";
import { cacheRows, ledgerTotals, lockCacheRows, signedQuantity, type CacheRow, type LedgerTotal } from "./ledger";
import { COST_VIEW, STOCK_ADJUST, STOCK_OPENING, STOCK_VIEW } from "./permissions";
import { stockLevels, stockMovements } from "./schema";

/**
 * Stock as the shop sees it. The quantity always comes from the journal (SUM of movements); the
 * cache is compared with it, and any disagreement is reported as "needs check" instead of being
 * hidden. Status rules (spec §5 "Low stock"): at or below reorder level → Low; below half of it →
 * Reorder now.
 */

export type StockStatus = "uncounted" | "out" | "reorder" | "low" | "healthy" | "needs_check";
export const STOCK_STATUS_FILTERS = ["all", "uncounted", "out", "reorder", "low", "healthy", "needs_check"] as const;
export type StockStatusFilter = (typeof STOCK_STATUS_FILTERS)[number];

export type StockRow = {
  productId: string;
  name: string;
  sku: string;
  categoryName: string | null;
  isActive: boolean;
  baseUnit: string;
  baseUnitName: string;
  /** null when nothing has been counted yet (no movements): unknown, not zero. */
  qty: string | null;
  reorderLevel: string;
  status: StockStatus;
  /** Why a row needs checking, in plain words. */
  problem: string | null;
};

function statusOf(product: ProductStockInputs, ledger: LedgerTotal | undefined, cache: CacheRow | undefined): { status: StockStatus; problem: string | null } {
  if (!ledger) {
    return cache && cache.qty !== BigInt(0) ? { status: "needs_check", problem: "A stored total exists without any stock entries." } : { status: "uncounted", problem: null };
  }
  if (!cache) return { status: "needs_check", problem: "The stored total is missing. The quantity shown is worked out from the stock entries." };
  if (cache.qty !== ledger.qty || cache.lastMovementId !== ledger.lastMovementId) {
    return { status: "needs_check", problem: "The stored total disagrees with the stock entries. The quantity shown is worked out from the entries." };
  }
  if (ledger.qty < BigInt(0)) return { status: "needs_check", problem: "Stock is below zero, which should not happen. Count it and fix it with an adjustment." };
  if (ledger.qty === BigInt(0)) return { status: "out", problem: null };
  if (ledger.qty * BigInt(2) < product.reorderLevel) return { status: "reorder", problem: null };
  if (ledger.qty <= product.reorderLevel) return { status: "low", problem: null };
  return { status: "healthy", problem: null };
}

const toRow = (product: ProductStockInputs, ledger: LedgerTotal | undefined, cache: CacheRow | undefined): StockRow => ({
  productId: product.id,
  name: product.name,
  sku: product.sku,
  categoryName: product.categoryName,
  isActive: product.isActive,
  baseUnit: product.baseUnit,
  baseUnitName: product.baseUnitName,
  qty: ledger ? formatQuantity(ledger.qty) : null,
  reorderLevel: formatQuantity(product.reorderLevel),
  ...statusOf(product, ledger, cache),
});

export const STOCK_PAGE_SIZE = 50;

async function stockRows(shopId: string, filters: { q?: string; categoryId?: string }) {
  const products = await listShopProductsForStock(shopId, { q: filters.q, categoryId: filters.categoryId });
  const ids = products.map((product) => product.id);
  const [ledger, cache] = await Promise.all([ledgerTotals(shopId, ids), cacheRows(shopId, ids)]);
  const rows = products.map((product) => toRow(product, ledger.get(product.id), cache.get(product.id)));
  const counts = { uncounted: 0, out: 0, reorder: 0, low: 0, healthy: 0, needs_check: 0 } satisfies Record<StockStatus, number>;
  for (const row of rows) counts[row.status] += 1;
  return { rows, counts };
}

const ALERT_ORDER: Partial<Record<StockStatus, number>> = { needs_check: 0, out: 1, reorder: 2, low: 3 };

/** Active products that are out, below half the reorder level, low, or need checking (dashboard), worst first. */
export async function stockAlerts(session: SessionContext, limit = 10) {
  await requirePermission(session, STOCK_VIEW);
  const { rows, counts } = await stockRows(session.shopId, {});
  const alerts = rows.filter((row) => row.isActive && ALERT_ORDER[row.status] !== undefined).sort((a, b) => ALERT_ORDER[a.status]! - ALERT_ORDER[b.status]! || a.name.localeCompare(b.name));
  return { counts, total: alerts.length, items: limit > 0 ? alerts.slice(0, limit) : alerts };
}

export async function listStock(
  session: SessionContext,
  filters: { q?: string; categoryId?: string; status?: StockStatusFilter; page?: number } = {},
): Promise<{ items: StockRow[]; total: number; page: number; pageSize: number; counts: Record<StockStatus, number> }> {
  await requirePermission(session, STOCK_VIEW);
  const { rows, counts } = await stockRows(session.shopId, filters);
  const status = filters.status ?? "all";
  const filtered = status === "all" ? rows : rows.filter((row) => row.status === status);
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  return { items: filtered.slice((page - 1) * STOCK_PAGE_SIZE, page * STOCK_PAGE_SIZE), total: filtered.length, page, pageSize: STOCK_PAGE_SIZE, counts };
}

export type StockMovementView = {
  id: number;
  date: string;
  kind: string;
  qty: string;
  reason: string | null;
  sourceType: string;
  createdByName: string;
  createdAt: Date;
  /** Only for viewers who may see costs. */
  unitCostPaise: number | null;
};

export const MOVEMENTS_PAGE_SIZE = 50;

export async function getProductStock(session: SessionContext, productId: string, options: { before?: number } = {}) {
  await requirePermission(session, STOCK_VIEW);
  const [product] = await loadProductsForStock(session.shopId, [productId]);
  if (!product) throw new NotFoundError("Product not found.");
  const [ledger, cache] = await Promise.all([ledgerTotals(session.shopId, [product.id]), cacheRows(session.shopId, [product.id])]);
  const movements = await getDb()
    .select()
    .from(stockMovements)
    .where(and(eq(stockMovements.shopId, session.shopId), eq(stockMovements.productId, product.id), options.before ? lt(stockMovements.id, options.before) : undefined))
    .orderBy(desc(stockMovements.id))
    .limit(MOVEMENTS_PAGE_SIZE + 1);
  const [names, showCost, canOpen, canAdjust] = await Promise.all([
    loadUserNames(session.shopId, [...new Set(movements.map((row) => row.createdBy))]),
    hasPermission(session, COST_VIEW),
    hasPermission(session, STOCK_OPENING),
    hasPermission(session, STOCK_ADJUST),
  ]);
  const row = toRow(product, ledger.get(product.id), cache.get(product.id));
  return {
    ...row,
    saleUnits: product.saleUnits.map((unit) => ({ code: unit.code, name: unit.name, factor: formatQuantity(unit.factor) })),
    baseAllowsDecimal: product.baseAllowsDecimal,
    /** Opening stock can only be entered for a product with no stock entries at all. */
    hasMovements: (ledger.get(product.id)?.movements ?? 0) > 0,
    movements: movements.slice(0, MOVEMENTS_PAGE_SIZE).map(
      (movement): StockMovementView => ({
        id: movement.id,
        date: movement.movementDate,
        kind: movement.kind,
        qty: formatQuantity(signedQuantity(movement.qtyBase)),
        reason: movement.reason,
        sourceType: movement.sourceType,
        createdByName: names.get(movement.createdBy) ?? "Unknown user",
        createdAt: movement.createdAt,
        unitCostPaise: showCost ? movement.unitCostPaise : null,
      }),
    ),
    moreBefore: movements.length > MOVEMENTS_PAGE_SIZE ? movements[MOVEMENTS_PAGE_SIZE - 1]!.id : null,
    permissions: { canOpen, canAdjust },
  };
}

/**
 * Rebuilds a product's cached total from the journal. Changes no stock: it only makes the cache
 * agree with the entries again, and is audited.
 */
export async function rebuildStockCache(session: SessionContext, productId: string): Promise<{ qty: string }> {
  await requirePermission(session, STOCK_ADJUST);
  return withTransaction(async (tx) => {
    const [product] = await lockProductsForStock(tx, session.shopId, [productId]);
    if (!product) throw new NotFoundError("Product not found.");
    await lockCacheRows(tx, session.shopId, [product.id]);
    const before = (await cacheRows(session.shopId, [product.id], tx)).get(product.id);
    const ledger = (await ledgerTotals(session.shopId, [product.id], tx)).get(product.id);
    const qty: Milli = ledger?.qty ?? BigInt(0);
    if (ledger) {
      await tx
        .insert(stockLevels)
        .values({ productId: product.id, shopId: session.shopId, qtyBase: toDbQuantity(qty), lastMovementId: ledger.lastMovementId })
        .onConflictDoUpdate({ target: stockLevels.productId, set: { qtyBase: toDbQuantity(qty), lastMovementId: ledger.lastMovementId, updatedAt: new Date() } });
    } else if (before) {
      await tx.delete(stockLevels).where(eq(stockLevels.productId, product.id));
    }
    await recordAudit(tx, { shopId: session.shopId, userId: session.userId, role: session.role }, {
      action: "inventory.cache_rebuilt",
      entityType: "product",
      entityId: product.id,
      before: before ? { qty: formatQuantity(before.qty), lastMovementId: before.lastMovementId } : null,
      after: { qty: formatQuantity(qty), lastMovementId: ledger?.lastMovementId ?? null },
    });
    return { qty: formatQuantity(qty) };
  });
}

/** Active products with no stock entries yet (the only ones that can get opening stock), with their units. */
export async function listOpeningCandidates(session: SessionContext) {
  await requirePermission(session, STOCK_OPENING);
  const products = await listShopProductsForStock(session.shopId);
  const ledger = await ledgerTotals(session.shopId, products.map((product) => product.id));
  const candidates = await loadProductsForStock(session.shopId, products.filter((product) => !ledger.has(product.id)).map((product) => product.id));
  return {
    canEnterCost: await hasPermission(session, COST_VIEW),
    products: candidates
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((product) => ({
        id: product.id,
        name: product.name,
        sku: product.sku,
        baseUnit: product.baseUnit,
        units: [
          { code: product.baseUnit, label: `${product.baseUnitName} (${product.baseUnit})`, factor: "1" },
          ...product.saleUnits.map((unit) => ({ code: unit.code, label: `${unit.name} of ${formatQuantity(unit.factor)} ${product.baseUnit}`, factor: formatQuantity(unit.factor) })),
        ],
      })),
  };
}

/** Whether any stock has been entered in the shop yet (the setup checklist). No permission check: yes/no only. */
export async function shopHasStockEntries(shopId: string): Promise<boolean> {
  const [row] = await getDb().select({ id: stockMovements.id }).from(stockMovements).where(eq(stockMovements.shopId, shopId)).limit(1);
  return Boolean(row);
}
