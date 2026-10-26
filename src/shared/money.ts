/**
 * Money helpers shared by browser and server. All amounts are integer paise (₹1 = 100 paise).
 * No floats are stored or summed; formatting is the only place rupees appear.
 */

export type Paise = number;

const rupeeFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

const rupeeFormatterWithPaise = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** ₹1,00,000 style. Pass `withPaise` to show two decimals (₹450.45). */
export function formatPaise(amount: Paise, options: { withPaise?: boolean } = {}): string {
  if (!Number.isInteger(amount)) {
    throw new Error(`formatPaise expects integer paise, got ${amount}`);
  }
  const formatter = options.withPaise ? rupeeFormatterWithPaise : rupeeFormatter;
  return formatter.format(amount / 100);
}

/** Short form for chart labels: ₹48.2k, ₹1.74 L. */
export function formatPaiseCompact(amount: Paise): string {
  const rupees = amount / 100;
  if (Math.abs(rupees) >= 100000) return `₹${(rupees / 100000).toFixed(2)} L`;
  if (Math.abs(rupees) >= 1000) return `₹${(rupees / 1000).toFixed(1)}k`;
  return formatPaise(amount);
}

/**
 * Parses a rupee amount typed by a person ("470", "470.5", "1,250.75") into integer paise
 * without floating-point arithmetic. Returns null when the text is not a valid amount.
 */
export function parseRupeesToPaise(input: string): Paise | null {
  const text = input.trim().replace(/^₹\s*/, "").replace(/,/g, "");
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const paise = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(paise) ? paise : null;
}

/** "470.50" — plain rupee text for form fields (no symbol, no grouping). */
export function paiseToRupeeInput(amount: Paise): string {
  const rupees = Math.trunc(amount / 100);
  const rest = Math.abs(amount % 100);
  return rest === 0 ? String(rupees) : `${rupees}.${String(rest).padStart(2, "0")}`;
}

export function sumPaise(amounts: readonly Paise[]): Paise {
  return amounts.reduce((total, amount) => total + amount, 0);
}
