import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/modules/audit";
import { hasPermission, requirePermission, type SessionContext } from "@/modules/identity";
import { getDb, withTransaction, type Database, type Transaction } from "@/server/db";
import { ConflictError, NotFoundError } from "@/server/errors";
import { financialYearLabel } from "@/shared/financial-year";
import { GST_REGISTRATIONS, gstinProblem, isGstState, STATUTORY_GST_RATES_BP, type GstRegistration, type TaxSettings } from "@/shared/gst";
import { numberSeries, shops } from "./schema";

/**
 * Business profile, GST and invoice settings (owner: `settings.edit`). Every change is validated here,
 * locks the shop row and writes an audit row with before/after. Bills already issued keep the tax mode
 * and numbers they were saved with; settings only affect bills made after the change.
 */

export const SETTINGS_EDIT = "settings.edit" as const;
const actorOf = (session: SessionContext) => ({ shopId: session.shopId, userId: session.userId, role: session.role });

export type InvoiceExtras = { terms: string | null; upiId: string | null; bankDetails: string | null };
/** Contact details kept with the shop's settings (no column of their own). */
export type ProfileExtras = { email: string | null; pinCode: string | null };

const profileExtrasOf = (settings: unknown): ProfileExtras => {
  const value = (settings ?? {}) as Partial<ProfileExtras>;
  return { email: value.email ?? null, pinCode: value.pinCode ?? null };
};

const optional = (max: number, message: string) =>
  z
    .string()
    .trim()
    .max(max, message)
    .optional()
    .transform((value) => value || null);

const profileSchema = z.object({
  name: z.string().trim().min(2, "Enter the shop name.").max(120, "Keep the name under 120 characters."),
  legalName: optional(160, "Keep the legal name under 160 characters."),
  address: optional(300, "Keep the address under 300 characters."),
  phone: z
    .string()
    .trim()
    .optional()
    .transform((value) => value?.replace(/[\s-]/g, "") || null)
    .pipe(z.string().regex(/^(\d{10}|0\d{9,11})$/, "Enter a 10-digit mobile or a landline with STD code.").nullable()),
  stateCode: z.string().refine(isGstState, "Choose the state."),
  email: optional(120, "Keep the email under 120 characters.").refine((value) => !value || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value), "That doesn't look like an email address."),
  pinCode: optional(6, "A PIN code has 6 digits.").refine((value) => !value || /^[1-9]\d{5}$/.test(value), "A PIN code has 6 digits and doesn't start with 0."),
});

const gstSchema = z
  .object({
    registration: z.enum(GST_REGISTRATIONS, { error: "Choose how the shop is registered for GST." }),
    gstin: z
      .string()
      .trim()
      .optional()
      .transform((value) => value?.toUpperCase() || null),
    interStateSales: z.union([z.boolean(), z.literal("on"), z.literal("")]).optional().transform((value) => value === true || value === "on"),
    gstRatesBp: z
      .array(z.coerce.number().int())
      .min(1, "Keep at least one GST rate.")
      .refine((rates) => rates.every((rate) => (STATUTORY_GST_RATES_BP as readonly number[]).includes(rate)), "Choose rates from the notified GST rates."),
  })
  .superRefine((data, ctx) => {
    if (data.registration === "unregistered" && data.gstin) ctx.addIssue({ code: "custom", path: ["gstin"], message: "An unregistered shop has no GSTIN. Clear it or choose a registration type." });
    if (data.registration !== "unregistered" && !data.gstin) ctx.addIssue({ code: "custom", path: ["gstin"], message: "Enter the shop's GSTIN." });
    if (data.registration !== "regular" && data.interStateSales) ctx.addIssue({ code: "custom", path: ["interStateSales"], message: "Only regular GST-registered shops can bill another state." });
  });

const invoiceSchema = z.object({
  invoicePrefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{1,4}$/, "Use 1 to 4 letters, for example INV."),
  startingNumber: z
    .string()
    .trim()
    .optional()
    .transform((value, ctx) => {
      if (!value) return null;
      if (!/^\d{1,5}$/.test(value) || Number(value) < 1) {
        ctx.addIssue({ code: "custom", message: "The starting number is a whole number from 1 to 99999." });
        return z.NEVER;
      }
      return Number(value);
    }),
  terms: optional(500, "Keep the terms under 500 characters."),
  upiId: optional(100, "Keep the UPI id under 100 characters.").refine((value) => !value || /^[\w.-]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/.test(value), "That doesn't look like a UPI id (name@bank)."),
  bankDetails: optional(300, "Keep the bank details under 300 characters."),
});

async function lockShop(tx: Transaction, shopId: string) {
  const [shop] = await tx.select().from(shops).where(eq(shops.id, shopId)).for("update").limit(1);
  if (!shop) throw new NotFoundError("Shop not found.");
  return shop;
}

const extrasOf = (settings: unknown): InvoiceExtras => {
  const value = (settings ?? {}) as Partial<InvoiceExtras>;
  return { terms: value.terms ?? null, upiId: value.upiId ?? null, bankDetails: value.bankDetails ?? null };
};

/** Next invoice number for the current financial year, and whether any bill was numbered yet. */
async function invoiceSeries(db: Database | Transaction, shopId: string, fyStartMonth: number, lock = false) {
  const fy = financialYearLabel(new Date(), fyStartMonth);
  const query = db.select({ nextValue: numberSeries.nextValue, startValue: numberSeries.startValue }).from(numberSeries).where(and(eq(numberSeries.shopId, shopId), eq(numberSeries.series, "INV"), eq(numberSeries.fy, fy)));
  const [row] = lock ? await query.for("update") : await query;
  return { fy, nextValue: row?.nextValue ?? 1, started: row ? row.nextValue > row.startValue : false };
}

export async function getBusinessSettings(session: SessionContext) {
  const db = getDb();
  const [shop] = await db.select().from(shops).where(eq(shops.id, session.shopId)).limit(1);
  if (!shop) throw new NotFoundError("Shop not found.");
  const series = await invoiceSeries(db, shop.id, shop.fyStartMonth);
  return {
    profile: { name: shop.name, legalName: shop.legalName, address: shop.address, phone: shop.phone, stateCode: shop.stateCode, ...profileExtrasOf(shop.settings) },
    gst: { registration: shop.gstRegistration as GstRegistration, gstin: shop.gstin, interStateSales: shop.interStateSales, gstRatesBp: [...shop.gstRatesBp].sort((a, b) => a - b) },
    invoice: { invoicePrefix: shop.invoicePrefix, ...extrasOf(shop.settings), fy: series.fy, nextNumber: series.nextValue, numberingStarted: series.started, sample: `${shop.invoicePrefix}/${series.fy}/${String(series.nextValue).padStart(5, "0")}` },
    canEdit: await hasPermission(session, SETTINGS_EDIT),
  };
}

export type BusinessSettings = Awaited<ReturnType<typeof getBusinessSettings>>;

export async function updateBusinessProfile(session: SessionContext, input: unknown) {
  await requirePermission(session, SETTINGS_EDIT);
  const data = profileSchema.parse(input);
  await withTransaction(async (tx) => {
    const shop = await lockShop(tx, session.shopId);
    if (shop.gstin && shop.gstin.slice(0, 2) !== data.stateCode) {
      throw new ConflictError("STATE_GSTIN_MISMATCH", `The shop's GSTIN is registered in state ${shop.gstin.slice(0, 2)}. Change the GSTIN first if the shop moved.`, { fieldErrors: { stateCode: "Must match the GSTIN's state." } });
    }
    const { email, pinCode, ...columns } = data;
    await tx
      .update(shops)
      .set({ ...columns, settings: sql`${shops.settings} || ${JSON.stringify({ email, pinCode })}::jsonb` })
      .where(eq(shops.id, shop.id));
    await recordAudit(tx, actorOf(session), { action: "settings.profile_updated", entityType: "shop", entityId: shop.id, before: { name: shop.name, legalName: shop.legalName, address: shop.address, phone: shop.phone, stateCode: shop.stateCode, ...profileExtrasOf(shop.settings) }, after: data });
  });
}

export async function updateGstSettings(session: SessionContext, input: unknown) {
  await requirePermission(session, SETTINGS_EDIT);
  const data = gstSchema.parse(input);
  await withTransaction(async (tx) => {
    const shop = await lockShop(tx, session.shopId);
    const problem = data.gstin ? gstinProblem(data.gstin, shop.stateCode) : null;
    if (problem) throw new ConflictError("GSTIN_INVALID", problem, { fieldErrors: { gstin: problem } });
    const after = { gstRegistration: data.registration, gstin: data.gstin, interStateSales: data.interStateSales, gstRatesBp: [...new Set(data.gstRatesBp)].sort((a, b) => a - b) };
    await tx.update(shops).set(after).where(eq(shops.id, shop.id));
    await recordAudit(tx, actorOf(session), { action: "settings.gst_updated", entityType: "shop", entityId: shop.id, before: { gstRegistration: shop.gstRegistration, gstin: shop.gstin, interStateSales: shop.interStateSales, gstRatesBp: shop.gstRatesBp }, after });
  });
}

export async function updateInvoiceSettings(session: SessionContext, input: unknown) {
  await requirePermission(session, SETTINGS_EDIT);
  const data = invoiceSchema.parse(input);
  await withTransaction(async (tx) => {
    const shop = await lockShop(tx, session.shopId);
    const series = await invoiceSeries(tx, shop.id, shop.fyStartMonth, true);
    // GST needs one consecutive series per financial year: prefix and starting number are fixed once the first bill is numbered.
    if (series.started && data.invoicePrefix !== shop.invoicePrefix) throw new ConflictError("NUMBERING_STARTED", `Bills of ${series.fy} are already numbered, so the prefix can change only from the next financial year.`, { fieldErrors: { invoicePrefix: "Fixed for this financial year." } });
    if (series.started && data.startingNumber !== null && data.startingNumber !== series.nextValue) throw new ConflictError("NUMBERING_STARTED", `Bills of ${series.fy} are already numbered, so the starting number can't change.`, { fieldErrors: { startingNumber: "Fixed for this financial year." } });
    if (!series.started && data.startingNumber !== null) {
      await tx.insert(numberSeries).values({ shopId: shop.id, series: "INV", fy: series.fy, nextValue: data.startingNumber, startValue: data.startingNumber }).onConflictDoUpdate({ target: [numberSeries.shopId, numberSeries.series, numberSeries.fy], set: { nextValue: data.startingNumber, startValue: data.startingNumber } });
    }
    const extras: InvoiceExtras = { terms: data.terms, upiId: data.upiId, bankDetails: data.bankDetails };
    await tx
      .update(shops)
      .set({ invoicePrefix: data.invoicePrefix, settings: sql`coalesce(${shops.settings}, '{}'::jsonb) || ${JSON.stringify(extras)}::jsonb` })
      .where(eq(shops.id, shop.id));
    await recordAudit(tx, actorOf(session), { action: "settings.invoice_updated", entityType: "shop", entityId: shop.id, before: { invoicePrefix: shop.invoicePrefix, nextNumber: series.nextValue, ...extrasOf(shop.settings) }, after: { invoicePrefix: data.invoicePrefix, nextNumber: data.startingNumber ?? series.nextValue, ...extras } });
  });
}

/** Tax settings for billing, read inside the caller's transaction. No permission check. */
export async function loadTaxSettings(tx: Database | Transaction, shopId: string): Promise<TaxSettings & { gstRatesBp: number[] }> {
  const [shop] = await tx.select({ registration: shops.gstRegistration, interStateSales: shops.interStateSales, stateCode: shops.stateCode, gstRatesBp: shops.gstRatesBp }).from(shops).where(eq(shops.id, shopId)).limit(1);
  if (!shop) throw new NotFoundError("Shop not found.");
  return { ...shop, registration: shop.registration as GstRegistration };
}

/** What a printed bill shows about the seller. No permission check (any staff who can view the bill). */
export async function invoiceProfile(shopId: string, db: Database | Transaction = getDb()) {
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId)).limit(1);
  if (!shop) throw new NotFoundError("Shop not found.");
  return { name: shop.name, legalName: shop.legalName, address: shop.address, phone: shop.phone, stateCode: shop.stateCode, gstin: shop.gstin, registration: shop.gstRegistration as GstRegistration, ...extrasOf(shop.settings), ...profileExtrasOf(shop.settings) };
}
