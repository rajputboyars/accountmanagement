import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createProduct, getProduct, updateProduct } from "@/modules/catalog";
import { recordOpeningStock } from "@/modules/inventory";
import { createCustomer, updateCustomer } from "@/modules/parties";
import { createInvoice, createReturn, getCreditNote, getInvoice, getReturnableInvoice, previewBill, previewReturn, type BillInput } from "@/modules/sales";
import { creditNotes, invoices } from "@/modules/sales/schema";
import { getBusinessSettings, updateBusinessProfile, updateGstSettings } from "@/modules/settings";
import { indiaDate } from "@/shared/financial-year";
import { gstinCheckDigit } from "@/shared/gst";
import { createTestShop, signInAs } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

/**
 * Issued documents keep the details they were issued with: a later change to the shop's profile or
 * GSTIN, a product's name or HSN, or a customer never rewrites a bill or credit note already issued.
 */
const db = setupTestDatabase();
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const today = indiaDate();
const gstin = (first14: string) => `${first14}${gstinCheckDigit(first14)}`;
let n = 0;

async function setup() {
  n += 1;
  const shop = await createTestShop(db, `GST docs ${n}`);
  const owner = (await signInAs(shop.users.owner)).session;
  await updateGstSettings(owner, { registration: "regular", gstin: gstin("08ABCDE1234F1Z"), interStateSales: true, gstRatesBp: [0, 500, 1200, 1800, 2800] });
  await updateBusinessProfile(owner, { name: `GST docs ${n}`, legalName: "Old Legal Name", address: "1 Old Road, Jaipur", phone: "9829012345", stateCode: "08", pinCode: "302001", email: "old@shop.in" });
  const { id: productId } = await createProduct(owner, { name: "CPVC Pipe 1\"", sku: `GD-${n}`, baseUnit: "pc", hsn: "3917", gstRateBp: "1800", retailPaise: "100", wholesalePaise: "90", costPaise: "60" });
  await recordOpeningStock(owner, { idempotencyKey: key(), movementDate: today, lines: [{ productId, unit: "pc", quantity: "100" }] });
  const { id: buyer } = await createCustomer(owner, { name: "Gupta Builders", phone: String(9840000000 + n), type: "retail", creditLimit: "100000", gstin: gstin("27ABCDE1234F1Z") });
  return { shop, owner, productId, buyer };
}
type Session = Awaited<ReturnType<typeof setup>>["owner"];
async function sell(session: Session, input: BillInput) {
  const preview = await previewBill(session, input);
  return createInvoice(session, { ...input, payments: { cash: String(preview.totals.totalPaise / 100) }, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates });
}

describe("issued documents keep their details", () => {
  it("prints a bill with the seller, buyer, product name and HSN it was issued with, even after they change", async () => {
    const { owner, productId, buyer } = await setup();
    const bill = await sell(owner, { customerId: buyer, placeOfSupply: "27", lines: [{ productId, unit: "pc", quantity: "2" }] } as BillInput);

    // Everything on the bill changes afterwards.
    await updateBusinessProfile(owner, { name: `Renamed ${n}`, legalName: "New Legal Name", address: "9 New Market, Jaipur", phone: "9829099999", stateCode: "08", pinCode: "302005", email: "new@shop.in" });
    const product = await getProduct(owner, productId);
    await updateProduct(owner, productId, { name: "Renamed Pipe", sku: product.sku, baseUnit: "pc", hsn: "391723", gstRateBp: "1800", retailPaise: "100", wholesalePaise: "90", costPaise: "60", version: product.version });
    await updateCustomer(owner, buyer, { name: "Gupta Builders Pvt Ltd", phone: String(9840000000 + n), type: "retail", creditLimit: "100000", gstin: "" });

    const printed = await getInvoice(owner, bill.id);
    expect(printed.shop).toMatchObject({ legalName: "Old Legal Name", address: "1 Old Road, Jaipur", pinCode: "302001", email: "old@shop.in", gstin: gstin("08ABCDE1234F1Z"), stateCode: "08" });
    expect(printed.customer).toMatchObject({ name: "Gupta Builders", gstin: gstin("27ABCDE1234F1Z") });
    expect(printed.lines[0]).toMatchObject({ productName: "CPVC Pipe 1\"", hsn: "3917", gstRateBp: 1800 });
    // Tax stays as issued: inter-state, IGST only.
    expect(printed).toMatchObject({ taxMode: "inter", placeOfSupply: "27", cgstPaise: 0, sgstPaise: 0, igstPaise: 3600, totalPaise: 23600 });

    // A new bill uses the new details.
    const fresh = await getInvoice(owner, (await sell(owner, { customerId: buyer, lines: [{ productId, unit: "pc", quantity: "1" }] })).id);
    expect(fresh.shop).toMatchObject({ legalName: "New Legal Name", address: "9 New Market, Jaipur", pinCode: "302005" });
    expect(fresh.customer).toMatchObject({ name: "Gupta Builders Pvt Ltd", gstin: null });
    expect(fresh.lines[0]).toMatchObject({ productName: "Renamed Pipe", hsn: "391723" });
    expect(fresh).toMatchObject({ taxMode: "intra", cgstPaise: 900, sgstPaise: 900, igstPaise: 0 });
  });

  it("credits a return with the original bill's tax split, and freezes the credit note's own details", async () => {
    const { owner, productId, buyer } = await setup();
    const bill = await sell(owner, { customerId: buyer, placeOfSupply: "27", lines: [{ productId, unit: "pc", quantity: "3" }] } as BillInput);
    await updateBusinessProfile(owner, { name: `Moved ${n}`, legalName: "Old Legal Name", address: "5 Moved Lane, Jaipur", phone: "9829012345", stateCode: "08", pinCode: "302010", email: "" });
    const [line] = (await getReturnableInvoice(owner, bill.id)).lines;
    const ret = { invoiceId: bill.id, lines: [{ invoiceLineId: line!.id, baseQty: "1", restock: true }], reason: "Extra", settlement: "cash" as const };
    const note = await createReturn(owner, { ...ret, idempotencyKey: key(), expectedTotalPaise: (await previewReturn(owner, ret)).totalPaise });
    const [row] = await db.owner.select().from(creditNotes).where(eq(creditNotes.id, note.id));
    expect(row).toMatchObject({ cgstPaise: 0, sgstPaise: 0, igstPaise: 1800, totalPaise: 11800 }); // IGST, like the bill
    // The credit note shows the address at the time it was issued; the bill still shows its own.
    await updateBusinessProfile(owner, { name: `Moved again ${n}`, legalName: "Old Legal Name", address: "7 Later Road, Jaipur", phone: "9829012345", stateCode: "08" });
    expect((await getCreditNote(owner, note.id)).shop).toMatchObject({ address: "5 Moved Lane, Jaipur", pinCode: "302010" });
    expect((await getInvoice(owner, bill.id)).shop).toMatchObject({ address: "1 Old Road, Jaipur" });
  });

  it("shows bills issued before snapshots with the current details, as before", async () => {
    const { owner, productId } = await setup();
    const bill = await sell(owner, { lines: [{ productId, unit: "pc", quantity: "1" }] });
    await db.owner.update(invoices).set({ seller: null, buyer: null }).where(eq(invoices.id, bill.id));
    await db.owner.execute(`update invoice_lines set product_name = null, hsn = null where invoice_id = '${bill.id}'`);
    await updateBusinessProfile(owner, { name: `Current ${n}`, legalName: "Current Legal", address: "Current Road", phone: "9829012345", stateCode: "08" });
    const printed = await getInvoice(owner, bill.id);
    expect(printed.shop).toMatchObject({ legalName: "Current Legal", address: "Current Road" });
    expect(printed.lines[0]).toMatchObject({ productName: "CPVC Pipe 1\"", hsn: null });
  });
});

describe("business profile details", () => {
  it("saves an optional email and PIN code, refuses bad ones, and keeps them to the shop", async () => {
    const { owner } = await setup();
    const other = await setup();
    const base = { name: `GST docs ${n}`, address: "1 Road", phone: "9829012345", stateCode: "08" };
    for (const bad of [{ email: "not-an-email" }, { pinCode: "02001" }, { pinCode: "3020011" }, { pinCode: "abcdef" }]) {
      await expect(updateBusinessProfile(owner, { ...base, ...bad }), JSON.stringify(bad)).rejects.toBeTruthy();
    }
    await updateBusinessProfile(owner, { ...base, email: "hello@shop.in", pinCode: "302001" });
    expect((await getBusinessSettings(owner)).profile).toMatchObject({ email: "hello@shop.in", pinCode: "302001" });
    expect((await getBusinessSettings(other.owner)).profile).toMatchObject({ email: "old@shop.in", pinCode: "302001" });
    await updateBusinessProfile(owner, { ...base, email: "", pinCode: "" });
    expect((await getBusinessSettings(owner)).profile).toMatchObject({ email: null, pinCode: null });
    // Settings stay owner-only.
    await expect(updateBusinessProfile((await signInAs(other.shop.users.manager)).session, { ...base, email: "x@y.in" })).rejects.toThrow();
  });
});
