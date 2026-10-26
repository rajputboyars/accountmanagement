/**
 * GST rules used by settings and billing. Pure (browser and server run the same code).
 *
 * Tax treatment is never guessed:
 *   - A shop that is not GST-registered, or is under the composition scheme, may not charge GST: it
 *     issues a "Bill of Supply" with no tax (CGST Act s.10(4), s.31(3)(c)); taxMode "none".
 *   - A regular registered shop charges CGST + SGST (UTGST in Union Territories without a
 *     legislature) when the place of supply is its own state, and IGST when the place of supply is
 *     another state (IGST Act s.7–8). Place of supply defaults to the shop's state (counter sale) and
 *     becomes another state only when the person billing chooses it, and only if the owner turned on
 *     inter-state sales in Settings (handoff B2 is still open, so it is off by default).
 */

export const GST_STATES: Record<string, string> = {
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
  "97": "Other Territory",
};

/** States in code order (object keys like "10" would otherwise sort before "01"). */
export const GST_STATE_LIST: [string, string][] = Object.entries(GST_STATES).sort(([a], [b]) => a.localeCompare(b));

/** Union Territories without a legislature levy UTGST instead of SGST on intra-state supplies. */
const UTGST_STATES = new Set(["04", "26", "31", "35", "38"]);

export function stateTaxLabel(stateCode: string): "SGST" | "UTGST" {
  return UTGST_STATES.has(stateCode) ? "UTGST" : "SGST";
}

export const isGstState = (code: string) => Object.hasOwn(GST_STATES, code);

/** GST rates notified for goods, in basis points. A shop chooses which of these it uses. */
export const STATUTORY_GST_RATES_BP = [0, 10, 25, 150, 300, 500, 1200, 1800, 2800, 4000] as const;
/** What existing shops had before rates were configurable. */
export const DEFAULT_GST_RATES_BP = [0, 500, 1200, 1800, 2800] as const;

export const GST_REGISTRATIONS = ["regular", "composition", "unregistered"] as const;
export type GstRegistration = (typeof GST_REGISTRATIONS)[number];
export type TaxMode = "intra" | "inter" | "none";

const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** The 15th character of a GSTIN (the GSTN mod-36 check digit). */
export function gstinCheckDigit(first14: string): string {
  let sum = 0;
  for (let index = 0; index < 14; index += 1) {
    const product = CHARSET.indexOf(first14[index]!) * (index % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARSET[(36 - (sum % 36)) % 36]!;
}

/** Null when the GSTIN is valid (format, state code and check digit), otherwise what is wrong. */
export function gstinProblem(gstin: string, expectedState?: string): string | null {
  if (!GSTIN_PATTERN.test(gstin)) return "A GSTIN has 15 characters, like 08ABCDE1234F1Z5.";
  if (!isGstState(gstin.slice(0, 2))) return "The GSTIN starts with an unknown state code.";
  if (gstinCheckDigit(gstin.slice(0, 14)) !== gstin[14]) return "This GSTIN's last character doesn't match; check for a typing mistake.";
  if (expectedState && gstin.slice(0, 2) !== expectedState) return `The GSTIN is for state ${gstin.slice(0, 2)}, but the shop's state is ${expectedState}.`;
  return null;
}

export type TaxSettings = { registration: GstRegistration; interStateSales: boolean; stateCode: string };

/**
 * The tax mode for a bill, or a reason it can't be billed this way. `placeOfSupply` null = the
 * shop's own state.
 */
export function resolveTaxMode(settings: TaxSettings, placeOfSupply: string | null): { mode: TaxMode; placeOfSupply: string } | { problem: string } {
  const place = placeOfSupply ?? settings.stateCode;
  if (!isGstState(place)) return { problem: "Choose a valid place of supply." };
  if (settings.registration !== "regular") {
    if (place !== settings.stateCode) return { problem: "Only GST-registered (regular) shops can bill another state." };
    return { mode: "none", placeOfSupply: place };
  }
  if (place === settings.stateCode) return { mode: "intra", placeOfSupply: place };
  if (!settings.interStateSales) return { problem: "Inter-state sales are turned off. The owner can turn them on in Settings → GST." };
  return { mode: "inter", placeOfSupply: place };
}

export const documentTitle = (mode: TaxMode) => (mode === "none" ? "Bill of Supply" : "Tax Invoice");

/** Wording composition dealers must print on every bill of supply (CGST Rules 5(1)). */
export const COMPOSITION_DECLARATION = "Composition taxable person, not eligible to collect tax on supplies.";
