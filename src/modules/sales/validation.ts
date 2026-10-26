import { z } from "zod";
import { parseRupeesToPaise } from "@/shared/money";
import { parsePercentToBasisPoints } from "@/shared/pricing-engine";
import { parseQuantity, QuantityError, type Milli } from "@/shared/quantity";

const id = (message: string) => z.string().regex(/^[0-9a-f-]{36}$/i, message);

const rupees = (label: string) =>
  z
    .string()
    .trim()
    .optional()
    .transform((value, ctx): number => {
      if (!value) return 0;
      const paise = parseRupeesToPaise(value);
      if (paise === null) {
        ctx.addIssue({ code: "custom", message: `Enter the ${label} in rupees, for example 500 or 250.50.` });
        return z.NEVER;
      }
      return paise;
    });

export const billLineSchema = z.object({
  productId: id("Choose a product."),
  unit: z.string().trim().min(1, "Choose a unit."),
  quantity: z
    .string()
    .trim()
    .transform((value, ctx): Milli => {
      try {
        const quantity = parseQuantity(value);
        if (quantity <= BigInt(0)) throw new QuantityError("Enter a quantity more than 0.");
        return quantity;
      } catch (error) {
        ctx.addIssue({ code: "custom", message: error instanceof QuantityError ? error.message : "Enter a valid quantity." });
        return z.NEVER;
      }
    }),
});

export const billInputSchema = z
  .object({
    /** Empty means the shop's walk-in customer. */
    customerId: z
      .string()
      .trim()
      .optional()
      .transform((value) => value || null)
      .pipe(id("Choose a customer.").nullable()),
    /** Empty means from the customer type. */
    priceList: z
      .enum(["", "retail", "wholesale"])
      .optional()
      .transform((value) => value || null),
    discountPercent: z
      .string()
      .trim()
      .optional()
      .transform((value, ctx): number => {
        if (!value) return 0;
        const basisPoints = parsePercentToBasisPoints(value);
        if (basisPoints === null || basisPoints > 10000) {
          ctx.addIssue({ code: "custom", message: "Enter a discount between 0% and 100%, for example 2 or 2.5." });
          return z.NEVER;
        }
        return basisPoints;
      }),
    lines: z.array(billLineSchema).min(1, "Add at least one item to the bill.").max(100, "A bill can have at most 100 lines."),
    payments: z
      .object({ cash: rupees("cash amount"), upi: rupees("UPI amount"), card: rupees("card amount"), bank: rupees("bank amount") })
      .default({ cash: 0, upi: 0, card: 0, bank: 0 }),
    /** Cash handed over by the customer, only to work out change. Never saved. */
    cashReceived: rupees("cash received"),
  })
  .superRefine((data, ctx) => {
    const seen = new Map<string, number>();
    data.lines.forEach((line, index) => {
      const first = seen.get(line.productId);
      if (first !== undefined) ctx.addIssue({ code: "custom", path: ["lines", index, "productId"], message: `This product is already on line ${first + 1}. Change that line's quantity instead.` });
      else seen.set(line.productId, index);
    });
  });

export const saveBillSchema = z.object({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, "This bill has expired. Reload the page."),
  /** The total and line rates the cashier saw. A difference means prices changed: nothing is saved. */
  expectedTotalPaise: z.number().int().nonnegative(),
  expectedRates: z.array(z.number().int().nonnegative()),
});

export const cancelInvoiceSchema = z.object({
  reason: z.string().trim().min(3, "Write the reason for cancelling (at least 3 characters).").max(200, "Keep the reason under 200 characters."),
});

export type BillInput = z.input<typeof billInputSchema>;
