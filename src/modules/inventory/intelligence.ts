import { sql } from "drizzle-orm";
import { hasPermission, requirePermission, type SessionContext } from "@/modules/identity";
import { getDb, type Database, type Transaction } from "@/server/db";
import { indiaDate } from "@/shared/financial-year";
import { formatQuantity, parseQuantity } from "@/shared/quantity";
import { AGE_BUCKETS, daysBetween, NON_MOVING_DAYS, replayProduct, slowStatus, type AgeBucket, type AgeMovement } from "@/shared/stock-age";
import { COST_VIEW, STOCK_VIEW } from "./permissions";

/**
 * Stock Not Selling. A simple answer for the owner (which items have stock but have not sold, how long, and how much money is
 * sitting in them) with the age of that stock as a secondary, clearly estimated detail. Nothing is stored: it is worked out from
 * the stock movements each time, so it can never disagree with them. See src/shared/stock-age.ts for what is exact and what is estimated.
 */

type Db = Database | Transaction;
export const DEFAULT_NOT_SELLING_DAYS = 60;
export const NOT_SELLING_CHOICES = [30, 60, 90, 180] as const;
const BATCH = 400;

export type GodownStockAge = {
  godownId: string;
  godownName: string;
  onHand: string;
  /** Quantity per age bucket (estimated, oldest stock assumed to leave first). Unknown = arrival date not on record. */
  buckets: Record<AgeBucket, string>;
  /** Null when the viewer cannot see costs. Only stock with a known cost is valued. */
  valuePaise: number | null;
};

export type NotSellingItem = {
  productId: string;
  name: string;
  baseUnit: string;
  onHand: string;
  status: "not_selling" | "never_sold";
  /** Slow (no sale for the chosen days) or not moving at all (180+ days, or never sold). */
  nonMoving: boolean;
  lastSaleDate: string | null;
  daysSinceLastSale: number | null;
  lastReceivedDate: string | null;
  /** Estimated value of the stock that has a known cost; null when the viewer cannot see costs. */
  valuePaise: number | null;
  /** True when some of the stock has no known cost, so the value is "at least". */
  valuePartial: boolean;
  ageReliable: boolean;
  /** Quantity whose arrival date is not on record (opening stock, returns, counts). Never guessed. */
  unknownAgeQty: string;
  godowns: GodownStockAge[];
};

export type StockNotSelling = {
  days: number;
  asOf: string;
  costVisible: boolean;
  items: NotSellingItem[];
  itemCount: number;
  nonMovingCount: number;
  valuePaise: number | null;
  valuePartial: boolean;
};

const zero = BigInt(0);

export async function stockNotSelling(session: SessionContext, options: { days?: number; asOf?: string } = {}, db: Db = getDb()): Promise<StockNotSelling> {
  await requirePermission(session, STOCK_VIEW, db);
  const days = options.days && options.days >= 7 && options.days <= 730 ? Math.floor(options.days) : DEFAULT_NOT_SELLING_DAYS;
  const asOf = options.asOf ?? indiaDate();
  const costVisible = await hasPermission(session, COST_VIEW, db);

  const stock = await db.execute<{ product_id: string; godown_id: string; qty: string; name: string; base_unit: string }>(sql`
    select s.product_id, s.godown_id, s.qty_base::text as qty, p.name, p.base_unit
    from stock_levels s join products p on p.id = s.product_id
    where s.shop_id = ${session.shopId}::uuid and s.qty_base > 0 and p.is_active
    order by p.name, s.product_id`);
  const godownNames = new Map<string, string>();
  const names = await db.execute<{ id: string; name: string }>(sql`select id, name from godowns where shop_id = ${session.shopId}::uuid`);
  for (const row of names.rows) godownNames.set(row.id, row.name);

  const byProduct = new Map<string, { name: string; baseUnit: string; onHand: Map<string, string> }>();
  for (const row of stock.rows) {
    const entry = byProduct.get(row.product_id) ?? { name: row.name, baseUnit: row.base_unit, onHand: new Map<string, string>() };
    entry.onHand.set(row.godown_id, row.qty);
    byProduct.set(row.product_id, entry);
  }

  const items: NotSellingItem[] = [];
  const productIds = [...byProduct.keys()];
  for (let i = 0; i < productIds.length; i += BATCH) {
    const chunk = productIds.slice(i, i + BATCH);
    const rows = await db.execute<{ id: string; product_id: string; godown_id: string; date: string; kind: string; qty: string; cost: string | null; source_type: string; source_id: string }>(sql`
      select id::text as id, product_id, godown_id, movement_date::text as date, kind, qty_base::text as qty, unit_cost_paise::text as cost, source_type, source_id::text as source_id
      from stock_movements where shop_id = ${session.shopId}::uuid and product_id in (${sql.join(chunk.map((id) => sql`${id}::uuid`), sql`, `)})
      order by product_id, id`);
    const grouped = new Map<string, AgeMovement[]>();
    for (const row of rows.rows) {
      const list = grouped.get(row.product_id) ?? [];
      list.push({ id: Number(row.id), godownId: row.godown_id, date: row.date, kind: row.kind, qty: row.qty, unitCostPaise: row.cost === null ? null : Number(row.cost), sourceType: row.source_type, sourceId: row.source_id });
      grouped.set(row.product_id, list);
    }
    for (const productId of chunk) {
      const product = byProduct.get(productId)!;
      const age = replayProduct(grouped.get(productId) ?? [], product.onHand, asOf);
      const onHand = [...product.onHand.values()].reduce((sum, qty) => sum + parseQuantity(qty), zero);
      const status = slowStatus({ onHand, lastSaleDate: age.lastSaleDate, lastReceivedDate: age.lastReceivedDate, asOf, days });
      if (status === "selling") continue;
      const daysSince = age.lastSaleDate ? daysBetween(age.lastSaleDate, asOf) : null;
      let value = 0;
      let uncosted = zero;
      let unknown = zero;
      const godowns: GodownStockAge[] = [];
      for (const [godownId, entry] of age.godowns) {
        const godownValue = AGE_BUCKETS.reduce((sum, bucket) => sum + entry.valuePaise[bucket], 0);
        value += godownValue;
        uncosted += entry.uncostedQty;
        unknown += entry.buckets.unknown;
        godowns.push({
          godownId,
          godownName: godownNames.get(godownId) ?? "",
          onHand: formatQuantity(entry.onHand),
          buckets: Object.fromEntries(AGE_BUCKETS.map((bucket) => [bucket, formatQuantity(entry.buckets[bucket])])) as Record<AgeBucket, string>,
          valuePaise: costVisible ? godownValue : null,
        });
      }
      godowns.sort((a, b) => a.godownName.localeCompare(b.godownName));
      items.push({
        productId,
        name: product.name,
        baseUnit: product.baseUnit,
        onHand: formatQuantity(onHand),
        status,
        nonMoving: status === "never_sold" || (daysSince !== null && daysSince >= Math.max(NON_MOVING_DAYS, days)),
        lastSaleDate: age.lastSaleDate,
        daysSinceLastSale: daysSince,
        lastReceivedDate: age.lastReceivedDate,
        valuePaise: costVisible ? value : null,
        valuePartial: uncosted > zero,
        ageReliable: age.ageReliable,
        unknownAgeQty: formatQuantity(unknown),
        godowns,
      });
    }
  }
  // Most money tied up first when costs can be seen; otherwise the longest quiet first.
  items.sort((a, b) => (b.valuePaise ?? 0) - (a.valuePaise ?? 0) || (b.daysSinceLastSale ?? 1e9) - (a.daysSinceLastSale ?? 1e9) || a.name.localeCompare(b.name));
  return {
    days,
    asOf,
    costVisible,
    items,
    itemCount: items.length,
    nonMovingCount: items.filter((item) => item.nonMoving).length,
    valuePaise: costVisible ? items.reduce((sum, item) => sum + (item.valuePaise ?? 0), 0) : null,
    valuePartial: items.some((item) => item.valuePartial),
  };
}
