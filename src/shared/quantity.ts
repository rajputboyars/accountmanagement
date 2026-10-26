/**
 * Exact decimal quantities, matching the database's numeric(14,3) / numeric(12,3) columns.
 * Values are held as integer thousandths in a BigInt ("milli"), so 2.5 boxes × 50 pieces is
 * exactly 125 — never 124.99999. JavaScript floating-point numbers are never used for quantities.
 * Shared by browser and server (no Node or database imports).
 */

const SCALE = 3;
const ONE = BigInt(1000);
const ZERO = BigInt(0);

export type Milli = bigint;

export class QuantityError extends Error {}

/** Parses "50", "2.5", "0.125" into thousandths. Rejects signs, exponents, commas and >3 decimals. */
export function parseQuantity(input: string, options: { maxIntegerDigits?: number; label?: string } = {}): Milli {
  const label = options.label ?? "Quantity";
  const maxIntegerDigits = options.maxIntegerDigits ?? 11; // numeric(14,3)
  const text = input.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new QuantityError(`${label} must be a number like 50 or 2.5.`);
  const [, whole, fraction = ""] = match;
  if (fraction.length > SCALE) throw new QuantityError(`${label} can have at most ${SCALE} decimal places.`);
  const trimmedWhole = whole!.replace(/^0+(?=\d)/, "");
  if (trimmedWhole.length > maxIntegerDigits) throw new QuantityError(`${label} is too large.`);
  return BigInt(trimmedWhole) * ONE + BigInt(fraction.padEnd(SCALE, "0"));
}

/** "50", "2.5", "0.125" — trailing zeros removed, for display. */
export function formatQuantity(value: Milli): string {
  const negative = value < ZERO;
  const abs = negative ? -value : value;
  const whole = abs / ONE;
  const fraction = (abs % ONE).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}

/** "50.000" — fixed three decimals, for numeric(…,3) columns. */
export function toDbQuantity(value: Milli): string {
  const negative = value < ZERO;
  const abs = negative ? -value : value;
  return `${negative ? "-" : ""}${(abs / ONE).toString()}.${(abs % ONE).toString().padStart(SCALE, "0")}`;
}

export function isWholeQuantity(value: Milli): boolean {
  return value % ONE === ZERO;
}

export const ONE_UNIT: Milli = ONE;

/**
 * Converts a quantity in a packaging unit to the product's base unit:
 * base = quantity × factor. Returns null when the exact result would need more than three
 * decimal places, so callers can refuse it instead of rounding silently.
 */
export function toBaseQuantity(quantity: Milli, factor: Milli): Milli | null {
  const product = quantity * factor; // scale 6
  if (product % ONE !== ZERO) return null;
  return product / ONE;
}
