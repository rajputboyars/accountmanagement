import { z } from "zod";
import { parseRupeesToPaise } from "@/shared/money";
import { parseQuantity, QuantityError, type Milli } from "@/shared/quantity";

const id = (message: string) => z.string().regex(/^[0-9a-f-]{36}$/i, message);
const optionalId = (message: string) =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => value || null)
    .pipe(id(message).nullable());

const quantity = z
  .string()
  .trim()
  .transform((value, ctx): Milli => {
    try {
      const parsed = parseQuantity(value);
      if (parsed <= BigInt(0)) throw new QuantityError("Enter a quantity more than 0.");
      return parsed;
    } catch (error) {
      ctx.addIssue({ code: "custom", message: error instanceof QuantityError ? error.message : "Enter a valid quantity." });
      return z.NEVER;
    }
  });

const rupees = (label: string) =>
  z
    .string()
    .trim()
    .transform((value, ctx) => {
      const paise = parseRupeesToPaise(value);
      if (paise === null || paise <= 0) {
        ctx.addIssue({ code: "custom", message: `Enter the ${label} in rupees, more than 0.` });
        return z.NEVER;
      }
      return paise;
    });

const key = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, "This form has expired. Reload the page.");

export const supplierInputSchema = z.object({
  name: z.string().trim().min(2, "Enter the supplier's name.").max(120),
  phone: z
    .string()
    .trim()
    .optional()
    .transform((value) => value?.replace(/[\s-]/g, "") || null)
    .pipe(z.string().regex(/^\+?\d{10,13}$/, "Enter a 10-digit mobile or a landline with STD code.").nullable()),
  gstin: z
    .string()
    .trim()
    .optional()
    .transform((value) => value?.toUpperCase() || null)
    .pipe(z.string().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "That doesn't look like a GSTIN (15 characters, e.g. 08ABCDE1234F1Z5).").nullable()),
  paymentTermsDays: z.coerce.number({ message: "Enter the payment terms in days." }).int().min(0, "Terms can't be negative.").max(365, "At most 365 days."),
});

export const purchaseOrderInputSchema = z
  .object({
    idempotencyKey: key,
    supplierId: id("Choose a supplier."),
    lines: z
      .array(z.object({ productId: id("Choose a product."), unit: z.string().trim().min(1, "Choose a unit."), quantity, cost: rupees("cost per unit") }))
      .min(1, "Add at least one item.")
      .max(100),
  })
  .superRefine((data, ctx) => {
    const seen = new Set<string>();
    data.lines.forEach((line, index) => {
      if (seen.has(line.productId)) ctx.addIssue({ code: "custom", path: ["lines", index, "productId"], message: "This product is already on the order." });
      seen.add(line.productId);
    });
  });

const GST_RATES = [0, 500, 1200, 1800, 2800];

export const receiptInputSchema = z
  .object({
    idempotencyKey: key,
    /** Receiving against an order; empty for a direct purchase (spec: the "Ordered" step is optional). */
    purchaseOrderId: optionalId("Choose the order."),
    supplierId: optionalId("Choose a supplier."),
    supplierBillNo: z
      .string()
      .trim()
      .max(30, "At most 30 characters.")
      .optional()
      .transform((value) => value?.toUpperCase().replace(/\s+/g, " ") || null),
    supplierBillDate: z
      .string()
      .optional()
      .transform((value) => value || null)
      .pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the bill date.").nullable()),
    lines: z
      .array(
        z.object({
          purchaseOrderLineId: optionalId("Choose an order line."),
          productId: optionalId("Choose a product."),
          unit: z.string().trim().optional(),
          quantity,
          cost: rupees("cost per unit"),
          gstRateBp: z.coerce.number().int().refine((value) => GST_RATES.includes(value), "Choose a GST rate."),
        }),
      )
      .min(1, "Receive at least one item.")
      .max(100),
  })
  .superRefine((data, ctx) => {
    if (!data.purchaseOrderId && !data.supplierId) ctx.addIssue({ code: "custom", path: ["supplierId"], message: "Choose a supplier." });
    const seen = new Set<string>();
    data.lines.forEach((line, index) => {
      const lineKey = line.purchaseOrderLineId ?? line.productId;
      if (!lineKey) {
        ctx.addIssue({ code: "custom", path: ["lines", index, "productId"], message: "Choose a product." });
        return;
      }
      if (seen.has(lineKey)) ctx.addIssue({ code: "custom", path: ["lines", index, "productId"], message: "This item is already on the receipt." });
      seen.add(lineKey);
    });
  });

export const supplierPaymentInputSchema = z.object({
  idempotencyKey: key,
  supplierId: id("Choose a supplier."),
  amount: rupees("amount"),
  method: z.enum(["cash", "upi", "bank", "cheque"], { message: "Choose how you paid." }),
  reference: z
    .string()
    .trim()
    .max(40, "At most 40 characters.")
    .optional()
    .transform((value) => value || null),
});

export const reasonSchema = z.object({ reason: z.string().trim().min(3, "Write a short reason (at least 3 characters).").max(200, "Keep the reason under 200 characters.") });
