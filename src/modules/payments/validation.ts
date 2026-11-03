import { z } from "zod";
import { parseRupeesToPaise } from "@/shared/money";

/** Pure, so the guide can check a field in the browser with the same rules the server saves by. */

export const receiptInputSchema = z.object({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, "This form has expired. Reload the page."),
  customerId: z.string().regex(/^[0-9a-f-]{36}$/i, "Choose a customer."),
  amount: z
    .string()
    .trim()
    .transform((value, ctx) => {
      const paise = parseRupeesToPaise(value);
      if (paise === null || paise <= 0) {
        ctx.addIssue({ code: "custom", message: "Enter the amount received, more than 0." });
        return z.NEVER;
      }
      return paise;
    }),
  method: z.enum(["cash", "upi", "bank", "cheque"], { message: "Choose how it was paid." }),
  reference: z
    .string()
    .trim()
    .max(40)
    .optional()
    .transform((value) => value || null),
});
