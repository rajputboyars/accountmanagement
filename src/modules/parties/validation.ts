import { z } from "zod";
import { LANGUAGES } from "@/shared/i18n/languages";
import { parseRupeesToPaise } from "@/shared/money";

/** Pure, so the guide can check a field in the browser with the same rules the server saves by. */

const rupees = z
  .string()
  .trim()
  .optional()
  .transform((value, ctx): number => {
    if (!value) return 0;
    const paise = parseRupeesToPaise(value);
    if (paise === null) {
      ctx.addIssue({ code: "custom", message: "Enter an amount in rupees." });
      return z.NEVER;
    }
    return paise;
  });

export const customerFields = z.object({
  name: z.string().trim().min(2, "Enter the customer's name.").max(120),
  phone: z
    .string()
    .trim()
    .optional()
    .transform((value) => value?.replace(/[\s-]/g, "") || null)
    .pipe(z.string().regex(/^\d{10}$/, "Phone must be 10 digits.").nullable()),
  type: z.enum(["retail", "wholesale"], { message: "Choose retail or wholesale." }),
  area: z
    .string()
    .trim()
    .max(80)
    .optional()
    .transform((value) => value || null),
  gstin: z
    .string()
    .trim()
    .optional()
    .transform((value) => value?.toUpperCase() || null)
    .pipe(z.string().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "That doesn't look like a GSTIN.").nullable()),
  creditLimit: rupees,
  whatsappConsent: z.union([z.boolean(), z.literal("on"), z.literal("")]).optional().transform((value) => value === true || value === "on"),
  /** Empty clears it; left out keeps what is saved, so other callers can't wipe it by accident. */
  communicationLanguage: z.union([z.enum(LANGUAGES, { message: "Choose a message language." }), z.literal("")]).optional().transform((value) => (value === "" ? null : value)),
});

export const customerCreateSchema = customerFields.extend({
  /** Owed at go-live (positive) or paid in advance (use advance). */
  openingOwed: rupees,
  openingAdvance: rupees,
  oldestBillDate: z
    .string()
    .optional()
    .transform((value) => value || null)
    .pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the date of the oldest unpaid bill.").nullable()),
});
