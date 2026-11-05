/**
 * Stock intelligence: when did an item last sell, and how old is the stock on the shelf?
 *
 * "Last sold" is exact: it is the date of the last sale or delivery that was not cancelled.
 *
 * Age is an ESTIMATE and is labelled as one. Nexora does not keep stock in dated batches, so age is worked out by replaying the
 * movements in order, assuming the oldest stock leaves first (FIFO). The replay keeps each piece of stock's original date through
 * transfers between godowns, and through a cancelled sale or delivery (the same pieces go back). Stock whose arrival date is not
 * known is never given one: opening stock, returned goods and count corrections are kept as "unknown age". Costs are only ever
 * the cost saved on the movement; where there was none the value is left out and counted separately. If the replay cannot be
 * reconciled with the stock actually on hand, the item says so instead of showing an age.
 *
 * Pure (no database, no Node), whole milli-units and whole paise.
 */

import { parseQuantity } from "./quantity";

export type AgeMovement = {
  id: number;
  godownId: string;
  /** Business date of the movement, YYYY-MM-DD. */
  date: string;
  kind: string;
  /** Signed quantity in base units, numeric(14,3) text. */
  qty: string;
  unitCostPaise: number | null;
  sourceType: string;
  sourceId: string;
};

export const AGE_BUCKETS = ["d0_30", "d31_90", "d91_180", "d181_365", "d365_plus", "unknown"] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

type Layer = { seq: number; qty: bigint; date: string | null; cost: number | null; origin: string | null; why: "received" | "opening" | "returned" | "found" };
type Piece = { godownId: string; layer: Layer };

export type GodownAge = {
  godownId: string;
  /** Quantity on hand per age bucket, milli-units. */
  buckets: Record<AgeBucket, bigint>;
  /** Value of the stock that has a known cost, per bucket, paise. */
  valuePaise: Record<AgeBucket, number>;
  /** Quantity (milli-units) with no known cost: its value is not included anywhere. */
  uncostedQty: bigint;
  onHand: bigint;
};

export type ProductAge = {
  /** Date of the last sale or delivery that was not cancelled; null if there has never been one. */
  lastSaleDate: string | null;
  /** Date stock was last received (a purchase), or null when no receipt is on record. */
  lastReceivedDate: string | null;
  /** False when the replay could not be reconciled with the stock on hand. Ages are then not shown. */
  ageReliable: boolean;
  godowns: Map<string, GodownAge>;
};

const MILLI = BigInt(1000);
/** Movement quantities are signed text such as "-4.000"; the stock quantity parser only takes unsigned ones. */
const signedMilli = (text: string): bigint => (text.trim().startsWith("-") ? -parseQuantity(text.trim().slice(1)) : parseQuantity(text.trim()));
const ZERO = BigInt(0);
const emptyBuckets = (): Record<AgeBucket, bigint> => ({ d0_30: ZERO, d31_90: ZERO, d91_180: ZERO, d181_365: ZERO, d365_plus: ZERO, unknown: ZERO });
const emptyValues = (): Record<AgeBucket, number> => ({ d0_30: 0, d31_90: 0, d91_180: 0, d181_365: 0, d365_plus: 0, unknown: 0 });
const dayNumber = (value: string) => Math.floor(new Date(`${value}T00:00:00Z`).getTime() / 86_400_000);

export const daysBetween = (from: string, to: string) => dayNumber(to) - dayNumber(from);

export function bucketOf(days: number): Exclude<AgeBucket, "unknown"> {
  if (days <= 30) return "d0_30";
  if (days <= 90) return "d31_90";
  if (days <= 180) return "d91_180";
  if (days <= 365) return "d181_365";
  return "d365_plus";
}

/** Whole paise for a milli-unit quantity at a per-base-unit cost, half-up. */
export const valueOf = (milliQty: bigint, unitCostPaise: number): number => Number((milliQty * BigInt(unitCostPaise) + BigInt(500)) / MILLI);

const SELLING = new Set(["sale", "delivery"]);
const SELLING_CANCEL: Record<string, string> = { sale_cancel: "sale", delivery_cancel: "delivery" };

/**
 * Replays one product's movements (oldest first) and returns when it last sold and how old its current stock is.
 * `onHand` is the quantity per godown the stock table says is there now; the replay must agree with it.
 */
export function replayProduct(movements: readonly AgeMovement[], onHand: ReadonlyMap<string, string>, asOf: string): ProductAge {
  const layers = new Map<string, Layer[]>();
  const consumed = new Map<string, Piece[]>();
  let reliable = true;
  let lastReceived = null as string | null;
  const sold = new Map<string, string>(); // source document -> date of the sale or delivery
  const cancelled = new Set<string>();

  const stack = (godownId: string) => {
    let list = layers.get(godownId);
    if (!list) layers.set(godownId, (list = []));
    return list;
  };
  const insert = (godownId: string, layer: Layer) => {
    const list = stack(godownId);
    list.push(layer);
    list.sort((a, b) => a.seq - b.seq);
  };
  /** Takes `qty` from a godown oldest-first (or a named receipt's layer first). Returns what was taken, and whether it was all there. */
  const take = (godownId: string, qty: bigint, preferOrigin?: string): { pieces: Piece[]; complete: boolean } => {
    const list = stack(godownId);
    const pieces: Piece[] = [];
    let need = qty;
    const order = preferOrigin ? [...list.filter((layer) => layer.origin === preferOrigin), ...list.filter((layer) => layer.origin !== preferOrigin)] : [...list];
    for (const layer of order) {
      if (need === ZERO) break;
      const part = layer.qty < need ? layer.qty : need;
      if (part === ZERO) continue;
      layer.qty -= part;
      need -= part;
      pieces.push({ godownId, layer: { ...layer, qty: part } });
    }
    layers.set(godownId, list.filter((layer) => layer.qty > ZERO));
    return { pieces, complete: need === ZERO };
  };

  for (const movement of movements) {
    const qty = signedMilli(movement.qty);
    const docKey = `${movement.kind}:${movement.sourceId}`;
    if (SELLING.has(movement.kind) && qty < ZERO) sold.set(`${movement.kind}:${movement.sourceId}`, movement.date);
    const cancelOf = SELLING_CANCEL[movement.kind];
    if (cancelOf) cancelled.add(`${cancelOf}:${movement.sourceId}`);

    if (qty > ZERO) {
      if (movement.kind === "purchase") {
        lastReceived = !lastReceived || movement.date > lastReceived ? movement.date : lastReceived;
        insert(movement.godownId, { seq: movement.id, qty, date: movement.date, cost: movement.unitCostPaise, origin: movement.sourceId, why: "received" });
      } else if (movement.kind === "opening") {
        insert(movement.godownId, { seq: movement.id, qty, date: null, cost: movement.unitCostPaise, origin: null, why: "opening" });
      } else if (movement.kind === "sale_cancel" || movement.kind === "delivery_cancel") {
        // The goods go back exactly as they left, with their own dates, as far as the original sale is known.
        const original = consumed.get(`${SELLING_CANCEL[movement.kind]}:${movement.sourceId}`) ?? [];
        let left = qty;
        for (const piece of original) {
          if (left === ZERO) break;
          const part = piece.layer.qty < left ? piece.layer.qty : left;
          if (part === ZERO) continue;
          insert(movement.godownId, { ...piece.layer, qty: part });
          piece.layer = { ...piece.layer, qty: piece.layer.qty - part };
          left -= part;
        }
        if (left > ZERO) insert(movement.godownId, { seq: movement.id, qty: left, date: null, cost: movement.unitCostPaise, origin: null, why: "returned" });
      } else if (movement.kind === "transfer_in") {
        const moved = consumed.get(`transfer:${movement.sourceId}`) ?? [];
        let left = qty;
        for (const piece of moved) {
          if (left === ZERO) break;
          const part = piece.layer.qty < left ? piece.layer.qty : left;
          if (part === ZERO) continue;
          insert(movement.godownId, { ...piece.layer, qty: part });
          piece.layer = { ...piece.layer, qty: piece.layer.qty - part };
          left -= part;
        }
        if (left > ZERO) insert(movement.godownId, { seq: movement.id, qty: left, date: null, cost: movement.unitCostPaise, origin: null, why: "found" });
      } else {
        // Returned by a customer, or found in a count: when this stock first arrived is not known, so it is not guessed.
        insert(movement.godownId, { seq: movement.id, qty, date: null, cost: movement.unitCostPaise, origin: null, why: movement.kind === "return_in" ? "returned" : "found" });
      }
      continue;
    }

    const out = -qty;
    const result = take(movement.godownId, out, movement.sourceType === "goods_receipt_cancel" ? movement.sourceId : undefined);
    if (!result.complete) reliable = false;
    if (movement.kind === "sale" || movement.kind === "delivery") consumed.set(docKey, result.pieces);
    else if (movement.kind === "transfer_out") consumed.set(`transfer:${movement.sourceId}`, result.pieces);
  }

  // The replay must agree with the stock table, godown by godown.
  const godowns = new Map<string, GodownAge>();
  const ids = new Set([...layers.keys(), ...onHand.keys()]);
  for (const godownId of ids) {
    const replayed = (layers.get(godownId) ?? []).reduce((sum, layer) => sum + layer.qty, ZERO);
    const actual = parseQuantity(onHand.get(godownId) ?? "0");
    if (replayed !== actual) reliable = false;
    const entry: GodownAge = { godownId, buckets: emptyBuckets(), valuePaise: emptyValues(), uncostedQty: ZERO, onHand: actual };
    if (actual > ZERO) {
      for (const layer of layers.get(godownId) ?? []) {
        const bucket: AgeBucket = layer.date === null ? "unknown" : bucketOf(daysBetween(layer.date, asOf));
        entry.buckets[bucket] += layer.qty;
        if (layer.cost === null) entry.uncostedQty += layer.qty;
        else entry.valuePaise[bucket] += valueOf(layer.qty, layer.cost);
      }
      godowns.set(godownId, entry);
    }
  }

  let lastSale: string | null = null;
  for (const [key, date] of sold) {
    if (cancelled.has(key)) continue;
    if (!lastSale || date > lastSale) lastSale = date;
  }
  return { lastSaleDate: lastSale, lastReceivedDate: lastReceived, ageReliable: reliable, godowns };
}

export type SlowStatus = "not_selling" | "never_sold" | "selling";

/**
 * Is this stock "not selling"? It has stock, no sale for `days` days (or none ever), and was not received within that time either,
 * so something that has only just arrived is not called slow. `never_sold` is for items with no sale on record at all.
 */
export function slowStatus(input: { onHand: bigint; lastSaleDate: string | null; lastReceivedDate: string | null; asOf: string; days: number }): SlowStatus {
  if (input.onHand <= ZERO) return "selling";
  const quiet = (date: string | null) => date === null || daysBetween(date, input.asOf) >= input.days;
  if (!quiet(input.lastSaleDate) || !quiet(input.lastReceivedDate)) return "selling";
  return input.lastSaleDate === null ? "never_sold" : "not_selling";
}

/** Stock with no sale for this many days is treated as not moving at all, rather than just slow. */
export const NON_MOVING_DAYS = 180;
