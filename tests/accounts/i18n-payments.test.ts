import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createProduct } from "@/modules/catalog";
import { setUserLanguage } from "@/modules/identity";
import { recordOpeningStock } from "@/modules/inventory";
import { partyBalance } from "@/modules/ledger";
import { ledgerEntries } from "@/modules/ledger/schema";
import { createCustomer } from "@/modules/parties";
import { recordCustomerReceipt, reverseCustomerReceipt } from "@/modules/payments";
import { payments } from "@/modules/payments/schema";
import { getCustomerAccount } from "@/modules/reporting";
import { cancelInvoice, createInvoice, previewBill } from "@/modules/sales";
import { toActionError } from "@/server/action-result";
import { translateServerMessage } from "@/shared/i18n";
import { statementLabel } from "@/shared/i18n/labels";
import { indiaDate } from "@/shared/financial-year";
import { paiseToRupeeInput } from "@/shared/money";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
let shop: TestShop;
const owner = async () => (await signInAs(shop.users.owner)).session;
const key = () => crypto.randomUUID().replace(/-/g, "");

beforeAll(async () => {
  shop = await createTestShop(db);
});

async function hindi(work: Promise<unknown>) {
  const error = await work.then(() => null, (caught: unknown) => caught);
  expect(error).not.toBeNull();
  return translateServerMessage((await toActionError(error)).error, "hi");
}

const counts = async (customerId: string) => ({
  payments: (await db.owner.select().from(payments).where(and(eq(payments.partyType, "customer"), eq(payments.partyId, customerId)))).length,
  ledger: (await db.owner.select().from(ledgerEntries).where(and(eq(ledgerEntries.partyType, "customer"), eq(ledgerEntries.partyId, customerId)))).length,
});

describe("customer payments in every language", () => {
  it("partial, full and advance payments, then a reversal, keep balances and records exact", async () => {
    const session = await owner();
    const { id } = await createCustomer(session, { name: "Gupta Builders", phone: "", type: "retail", creditLimit: "5000", openingOwed: "1000", oldestBillDate: "2026-04-01" });
    const balance = () => partyBalance(session.shopId, "customer", id);
    expect(await balance()).toBe(100000);

    // Partial, in Hindi; the same request again is one payment, not two.
    await setUserLanguage(session, "hi");
    const partialInput = { idempotencyKey: key(), customerId: id, amount: "300", method: "upi", reference: "UTR-77" };
    const partial = await recordCustomerReceipt(session, partialInput);
    expect(partial).toMatchObject({ balanceBeforePaise: 100000, balanceAfterPaise: 70000, advancePaise: 0, replayed: false });
    expect((await recordCustomerReceipt(session, partialInput)).replayed).toBe(true);
    const afterPartial = await counts(id);

    // Full, in Hinglish.
    await setUserLanguage(session, "hinglish");
    const full = await recordCustomerReceipt(session, { idempotencyKey: key(), customerId: id, amount: "700", method: "cash", reference: "" });
    expect(full).toMatchObject({ balanceAfterPaise: 0, advancePaise: 0 });

    // More than is owed becomes an advance, in English.
    await setUserLanguage(session, "en");
    const advance = await recordCustomerReceipt(session, { idempotencyKey: key(), customerId: id, amount: "250", method: "cheque", reference: "CHQ-9" });
    expect(advance).toMatchObject({ balanceAfterPaise: -25000, advancePaise: 25000 });

    // Stored identifiers are the codes, whichever language each was saved in.
    const rows = await db.owner.select().from(payments).where(and(eq(payments.partyType, "customer"), eq(payments.partyId, id)));
    expect(rows.map((row) => row.method).sort()).toEqual(["cash", "cheque", "upi"]);
    expect(afterPartial).toEqual({ payments: 1, ledger: 2 });

    // Refusals save nothing and read in the person's language.
    const before = await counts(id);
    expect(await hindi(recordCustomerReceipt(session, { idempotencyKey: key(), customerId: id, amount: "0", method: "cash", reference: "" }))).toBe(translateServerMessage("Enter the amount received, more than 0.", "hi"));
    expect(await hindi(recordCustomerReceipt(session, { idempotencyKey: key(), customerId: id, amount: "10", method: "gold", reference: "" }))).toMatch(/[ऀ-ॿ]/);
    expect(await hindi(recordCustomerReceipt(session, { idempotencyKey: key(), customerId: id, amount: "10", method: "cheque", reference: "" }))).toBe(translateServerMessage("Enter the cheque number.", "hi"));
    const duplicate = await hindi(recordCustomerReceipt(session, { idempotencyKey: key(), customerId: id, amount: "10", method: "upi", reference: "UTR-77" }));
    expect(duplicate).toContain("UTR-77");
    expect(duplicate).not.toMatch(/already/);
    expect(await hindi(reverseCustomerReceipt(session, full.id, { reason: "x" }))).toMatch(/[ऀ-ॿ]/);
    expect(await counts(id)).toEqual(before);

    // A reversal is one matching pair; doing it again is refused.
    await reverseCustomerReceipt(session, full.id, { reason: "Entered twice" });
    expect(await balance()).toBe(45000);
    expect(await counts(id)).toEqual({ payments: before.payments + 1, ledger: before.ledger + 1 });
    expect(await hindi(reverseCustomerReceipt(session, full.id, { reason: "Entered twice" }))).toBe(translateServerMessage("This receipt is already reversed.", "hi"));

    // The statement says reversal, never refund, and switching language changes nothing saved.
    const account = await getCustomerAccount(session, id);
    const reversal = account.statement.map((line) => line.description).find((text) => text.startsWith("Reversal"));
    expect(reversal).toBe("Reversal · CASH");
    expect(account.statement.map((line) => line.description)).not.toContain("Refund · CASH");
    expect(statementLabel(reversal!, "hi")).toBe("एंट्री वापस ली · नकद");
    const saved = await db.owner.select().from(payments).where(eq(payments.partyId, id));
    for (const language of ["hi", "hinglish", "en"] as const) await setUserLanguage(session, language);
    expect(await db.owner.select().from(payments).where(eq(payments.partyId, id))).toEqual(saved);
    expect(await balance()).toBe(45000);
  });

  it("cancelling a paid bill reads as a refund, not a reversal", async () => {
    const session = await owner();
    const { id: productId } = await createProduct(session, { name: "CPVC Pipe", sku: "CP-P", baseUnit: "pc", hsn: "3917", gstRateBp: "1800", retailPaise: "100", wholesalePaise: "90", costPaise: "50" });
    await recordOpeningStock(session, { idempotencyKey: key(), movementDate: indiaDate(), lines: [{ productId, unit: "pc", quantity: "10" }] } as never);
    const { id: customerId } = await createCustomer(session, { name: "Verma Interiors", phone: "", type: "retail", creditLimit: "0" });
    const billInput = (cash: string) => ({ customerId, priceList: "", discountPercent: "", lines: [{ productId, unit: "pc", quantity: "1" }], payments: { cash, upi: "", card: "", bank: "" }, cashReceived: "", placeOfSupply: "" });
    const first = await previewBill(session, billInput(""));
    const input = billInput(paiseToRupeeInput(first.totals.totalPaise));
    const preview = await previewBill(session, input);
    const bill = await createInvoice(session, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates });
    await cancelInvoice(session, bill.id, { reason: "galat maal" });

    const lines = (await getCustomerAccount(session, customerId)).statement.map((line) => line.description);
    expect(lines).toContain("Refund · CASH");
    expect(lines).not.toContain("Reversal · CASH");
    expect(statementLabel("Refund · CASH", "hinglish")).toBe("Paisa wapas kiya · Cash");
  });
});
