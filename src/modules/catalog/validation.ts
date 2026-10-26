import { z } from "zod";
import { parseRupeesToPaise } from "@/shared/money";
import { parseQuantity, QuantityError, type Milli } from "@/shared/quantity";

/** Server-side input rules for the catalog. Messages are written for shopkeepers. */

export const GST_RATE_OPTIONS = [0, 500, 1200, 1800, 2800] as const;

const optionalText = (max: number, message: string) =>
  z
    .string()
    .trim()
    .max(max, message)
    .optional()
    .transform((value) => (value ? value : undefined));

const rupees = (label: string) =>
  z
    .string({ error: `Enter the ${label}.` })
    .trim()
    .min(1, `Enter the ${label}.`)
    .transform((value, ctx) => {
      const paise = parseRupeesToPaise(value);
      if (paise === null) {
        ctx.addIssue({ code: "custom", message: `The ${label} should be an amount like 470 or 470.50.` });
        return z.NEVER;
      }
      if (paise <= 0) {
        ctx.addIssue({ code: "custom", message: `The ${label} must be more than ₹0.` });
        return z.NEVER;
      }
      return paise;
    });

export const unitCodeSchema = z
  .string({ error: "Choose a unit." })
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9]{0,15}$/, "Short name: lowercase letters and digits, starting with a letter (for example pc, box, m).");

export const unitInputSchema = z.object({
  name: z.string().trim().min(1, "Enter the unit name.").max(40, "Keep the unit name under 40 characters."),
  code: unitCodeSchema,
  allowDecimal: z.boolean().default(false),
});

export const productInputSchema = z.object({
  name: z.string({ error: "Enter the product name." }).trim().min(2, "Enter the product name.").max(120, "Keep the name under 120 characters."),
  sku: z
    .string({ error: "Enter a product code." })
    .trim()
    .toUpperCase()
    .min(1, "Enter a product code.")
    .max(30, "Keep the product code under 30 characters.")
    .regex(/^[A-Z0-9][A-Z0-9._/-]*$/, "Product code: letters, digits and - _ . / only."),
  barcode: optionalText(30, "Keep the barcode under 30 characters.").refine((value) => !value || /^[0-9A-Za-z-]+$/.test(value), "Barcode: letters, digits and - only."),
  categoryName: optionalText(60, "Keep the category under 60 characters."),
  description: optionalText(500, "Keep the description under 500 characters."),
  baseUnit: unitCodeSchema,
  hsn: z
    .string({ error: "Enter the HSN code." })
    .trim()
    .regex(/^\d{4}(\d{2}){0,2}$/, "HSN code should be 4, 6 or 8 digits."),
  gstRateBp: z.coerce
    .number({ error: "Choose the GST rate." })
    .refine((value) => (GST_RATE_OPTIONS as readonly number[]).includes(value), "Choose the GST rate."),
  retailPaise: rupees("retail price"),
  wholesalePaise: rupees("wholesale price"),
  costPaise: z
    .string()
    .trim()
    .optional()
    .transform((value, ctx) => {
      if (!value) return null;
      const paise = parseRupeesToPaise(value);
      if (paise === null) {
        ctx.addIssue({ code: "custom", message: "The cost price should be an amount like 402 or 402.50." });
        return z.NEVER;
      }
      return paise;
    }),
});

export type ProductInput = z.output<typeof productInputSchema>;

export const productUpdateSchema = productInputSchema.extend({
  version: z.coerce.number().int().positive(),
});

/** How many base units one packaging unit holds, e.g. "50" pieces in a box or "3" meters in a length. */
export const conversionFactorSchema = z
  .string({ error: "Enter how many base units are in one." })
  .trim()
  .min(1, "Enter how many base units are in one.")
  .transform((value, ctx): Milli => {
    try {
      return parseQuantity(value, { maxIntegerDigits: 9, label: "The amount" }); // numeric(12,3)
    } catch (error) {
      ctx.addIssue({ code: "custom", message: error instanceof QuantityError ? error.message : "Enter a number like 50 or 2.5." });
      return z.NEVER;
    }
  });

export const productUnitInputSchema = z.object({
  unit: unitCodeSchema,
  factor: conversionFactorSchema,
});
