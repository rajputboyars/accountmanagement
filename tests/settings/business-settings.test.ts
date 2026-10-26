import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog } from "@/modules/audit/schema";
import { createProduct } from "@/modules/catalog";
import { recordOpeningStock } from "@/modules/inventory";
import { createInvoice, createReturn, getInvoice, getReturnableInvoice, previewBill, previewReturn, type BillInput } from "@/modules/sales";
import { invoiceLines, invoices } from "@/modules/sales/schema";
import { getBusinessSettings, updateBusinessProfile, updateGstSettings, updateInvoiceSettings } from "@/modules/settings";
import { ForbiddenError } from "@/server/errors";
import { indiaDate } from "@/shared/financial-year";
import { gstinCheckDigit } from "@/shared/gst";
import { createTestShop, signInAs } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const today = indiaDate();
const gstin = (first14: string) => `${first14}${gstinCheckDigit(first14)}`;
const RAJASTHAN_GSTIN = gstin("08ABCDE1234F1Z");
let n = 0;

async function setup() {
  n += 1;
  const shop = await createTestShop(db, `GST ${n}`); // state 08 (Rajasthan), regular, rates 0/5/12/18/28
  const owner = (await signInAs(shop.users.owner)).session;
  const { id: productId } = await createProduct(owner, { name: `Pipe ${n}`, sku: `GP-${n}`, baseUnit: "pc", hsn: "3917", gstRateBp: "1800", retailPaise: "100", wholesalePaise: "90", costPaise: "60" });
  await recordOpeningStock(owner, { idempotencyKey: key(), movementDate: today, lines: [{ productId, unit: "pc", quantity: "100" }] });
  return { shop, owner, productId };
}

type Session = Awaited<ReturnType<typeof setup>>["owner"];
const gst = (session: Session, values: Record<string, unknown>) => updateGstSettings(session, { registration: "regular", gstin: RAJASTHAN_GSTIN, gstRatesBp: [0, 500, 1200, 1800, 2800], ...values });

/** A walk-in cash bill for `quantity` pipes at ₹100 + GST. */
async function cashBill(session: Session, productId: string, quantity: string, extra: Partial<BillInput> = {}) {
  const input = { lines: [{ productId, unit: "pc", quantity }], ...extra } as unknown as BillInput;
  const preview = await previewBill(session, input);
  const rupees = String(preview.totals.totalPaise / 100);
  return createInvoice(session, { ...input, payments: { cash: rupees }, cashReceived: rupees, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates });
}

describe("business settings", () => {
  it("only the owner changes settings; every change is validated and audited", async () => {
    const { shop, owner } = await setup();
    const manager = (await signInAs(shop.users.manager)).session;
    await expect(updateBusinessProfile(manager, { name: "Hacked", stateCode: "08" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(gst(manager, {})).rejects.toBeInstanceOf(ForbiddenError);
    expect((await getBusinessSettings(manager)).canEdit).toBe(false);

    await updateBusinessProfile(owner, { name: "Sharma Sanitary", legalName: "Sharma Sanitary & Hardware", address: "12 MI Road, Jaipur", phone: "98290 12345", stateCode: "08" });
    const settings = await getBusinessSettings(owner);
    expect(settings.profile).toMatchObject({ legalName: "Sharma Sanitary & Hardware", phone: "9829012345", stateCode: "08" });
    const [audit] = await db.owner.select().from(auditLog).where(and(eq(auditLog.shopId, shop.shopId), eq(auditLog.action, "settings.profile_updated")));
    expect(audit).toMatchObject({ userId: owner.userId, before: { name: `GST ${n}` }, after: { name: "Sharma Sanitary" } });
    await expect(updateBusinessProfile(owner, { name: "X", stateCode: "08" })).rejects.toBeInstanceOf(Error);
    await expect(updateBusinessProfile(owner, { name: "Valid", stateCode: "99" })).rejects.toBeTruthy();
  });

  it("validates GST registration and the GSTIN against the shop's state", async () => {
    const { owner } = await setup();
    await expect(gst(owner, { gstin: "" })).rejects.toThrow("Enter the shop's GSTIN.");
    await expect(gst(owner, { gstin: "08ABCDE1234F1ZZ" })).rejects.toMatchObject({ code: "GSTIN_INVALID" });
    await expect(gst(owner, { gstin: gstin("27ABCDE1234F1Z") })).rejects.toThrow(/state 27/);
    await expect(gst(owner, { registration: "unregistered" })).rejects.toThrow(/unregistered shop has no GSTIN/);
    await expect(gst(owner, { registration: "composition", interStateSales: true })).rejects.toThrow(/Only regular/);
    await expect(gst(owner, { gstRatesBp: [1700] })).rejects.toThrow("Choose rates from the notified GST rates.");
    await gst(owner, { gstin: RAJASTHAN_GSTIN.toLowerCase(), interStateSales: "on" });
    expect((await getBusinessSettings(owner)).gst).toMatchObject({ registration: "regular", gstin: RAJASTHAN_GSTIN, interStateSales: true });
    // The state can't drift away from the GSTIN.
    await expect(updateBusinessProfile(owner, { name: "Shop", stateCode: "27" })).rejects.toMatchObject({ code: "STATE_GSTIN_MISMATCH" });
  });

  it("limits product GST rates to the shop's list", async () => {
    const { owner } = await setup();
    const forty = { name: `Lux ${n}`, sku: `LX-${n}`, baseUnit: "pc", hsn: "8481", gstRateBp: "4000", retailPaise: "100", wholesalePaise: "90" };
    await expect(createProduct(owner, forty)).rejects.toMatchObject({ code: "GST_RATE_NOT_ENABLED" });
    await gst(owner, { gstRatesBp: [0, 500, 1800, 4000] });
    await expect(createProduct(owner, forty)).resolves.toMatchObject({ id: expect.any(String) });
  });
});

describe("billing with saved GST settings", () => {
  it("issues a Bill of Supply with no GST for an unregistered shop, and credits it without tax", async () => {
    const { owner, productId } = await setup();
    await updateGstSettings(owner, { registration: "unregistered", gstin: "", gstRatesBp: [0, 1800] });
    const bill = await cashBill(owner, productId, "3");
    const [row] = await db.owner.select().from(invoices).where(eq(invoices.id, bill.id));
    expect(row).toMatchObject({ taxMode: "none", cgstPaise: 0, sgstPaise: 0, igstPaise: 0, taxablePaise: 30000, totalPaise: 30000, placeOfSupply: "08" });
    const [line] = await db.owner.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, bill.id));
    expect(line).toMatchObject({ gstRateBp: 0, cgstPaise: 0, igstPaise: 0 });
    expect((await getInvoice(owner, bill.id)).shop.registration).toBe("unregistered");
    const [lineId] = (await getReturnableInvoice(owner, bill.id)).lines.map((item) => item.id);
    const ret = { invoiceId: bill.id, lines: [{ invoiceLineId: lineId!, baseQty: "1", restock: true }], reason: "Extra", settlement: "cash" as const };
    expect(await previewReturn(owner, ret)).toMatchObject({ cgstPaise: 0, igstPaise: 0, totalPaise: 10000, taxMode: "none" });
  });

  it("charges CGST + SGST at the counter and IGST only for an explicit other-state place of supply that the owner allowed", async () => {
    const { owner, productId } = await setup();
    await gst(owner, {});
    const local = await cashBill(owner, productId, "2");
    const [localRow] = await db.owner.select().from(invoices).where(eq(invoices.id, local.id));
    expect(localRow).toMatchObject({ taxMode: "intra", cgstPaise: 1800, sgstPaise: 1800, igstPaise: 0, totalPaise: 23600 });
    // Inter-state is off: an other-state place of supply is refused, never silently taxed as local.
    await expect(cashBill(owner, productId, "2", { placeOfSupply: "27" } as Partial<BillInput>)).rejects.toMatchObject({ code: "PLACE_OF_SUPPLY" });
    await gst(owner, { interStateSales: true });
    const away = await cashBill(owner, productId, "2", { placeOfSupply: "27" } as Partial<BillInput>);
    const [awayRow] = await db.owner.select().from(invoices).where(eq(invoices.id, away.id));
    expect(awayRow).toMatchObject({ taxMode: "inter", placeOfSupply: "27", cgstPaise: 0, sgstPaise: 0, igstPaise: 3600, totalPaise: 23600 });
    const [lineId] = (await getReturnableInvoice(owner, away.id)).lines.map((item) => item.id);
    const ret = { invoiceId: away.id, lines: [{ invoiceLineId: lineId!, baseQty: "1", restock: true }], reason: "Damaged in transit", settlement: "cash" as const };
    const note = await createReturn(owner, { ...ret, idempotencyKey: key(), expectedTotalPaise: (await previewReturn(owner, ret)).totalPaise });
    expect(note.totalPaise).toBe(11800);
    // Turning inter-state off later doesn't change bills already issued.
    await gst(owner, { interStateSales: false });
    expect((await getInvoice(owner, away.id)).taxMode).toBe("inter");
  });

  it("numbers bills with the saved prefix and starting number, fixed once the year's first bill exists", async () => {
    const { owner, productId } = await setup();
    await expect(updateInvoiceSettings(owner, { invoicePrefix: "TOOLONG" })).rejects.toBeTruthy();
    await updateInvoiceSettings(owner, { invoicePrefix: "bill", startingNumber: "101", upiId: "sharma@okhdfcbank", terms: "Goods once sold are exchanged within 7 days with the bill." });
    const settings = await getBusinessSettings(owner);
    expect(settings.invoice).toMatchObject({ invoicePrefix: "BILL", nextNumber: 101, numberingStarted: false, upiId: "sharma@okhdfcbank" });
    const first = await cashBill(owner, productId, "1");
    expect(first.number).toMatch(/^BILL\/\d{2}-\d{2}\/00101$/);
    expect(first.number.length).toBeLessThanOrEqual(16);
    await expect(updateInvoiceSettings(owner, { invoicePrefix: "INV" })).rejects.toMatchObject({ code: "NUMBERING_STARTED" });
    await expect(updateInvoiceSettings(owner, { invoicePrefix: "BILL", startingNumber: "500" })).rejects.toMatchObject({ code: "NUMBERING_STARTED" });
    await updateInvoiceSettings(owner, { invoicePrefix: "BILL", upiId: "", terms: "New terms" }); // extras can still change
    expect((await getInvoice(owner, first.id)).shop.terms).toBe("New terms");
    expect((await cashBill(owner, productId, "1")).number).toMatch(/\/00102$/);
    const [audit] = await db.owner.select().from(auditLog).where(and(eq(auditLog.shopId, owner.shopId), eq(auditLog.action, "settings.invoice_updated"))).orderBy(auditLog.id);
    expect(audit).toMatchObject({ before: { invoicePrefix: "INV", nextNumber: 1 } });
  });

  it("keeps each shop's settings apart", async () => {
    const a = await setup();
    const b = await setup();
    await updateInvoiceSettings(b.owner, { invoicePrefix: "BB" });
    expect((await getBusinessSettings(a.owner)).invoice.invoicePrefix).toBe("INV");
    expect((await cashBill(a.owner, a.productId, "1")).number).toMatch(/^INV\//);
  });
});
