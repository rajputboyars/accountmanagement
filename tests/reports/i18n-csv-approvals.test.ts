import { beforeAll, describe, expect, it, vi } from "vitest";
import { GET as reportCsv } from "@/app/(app)/reports/[kind]/csv/route";
import { GET as statementCsv } from "@/app/(app)/customers/[customerId]/statement/csv/route";
import { closeDay, getCashbook, recordExpense, reopenDay, voidExpense } from "@/modules/cashbook";
import { createProduct } from "@/modules/catalog";
import { recordOpeningStock } from "@/modules/inventory";
import { decideApproval, listApprovals, requestApproval, type SessionContext } from "@/modules/identity";
import { createCustomer } from "@/modules/parties";
import { recordCustomerReceipt } from "@/modules/payments";
import { toActionError } from "@/server/action-result";
import { indiaDate } from "@/shared/financial-year";
import { translateServerMessage, translatorFor, type Language } from "@/shared/i18n";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

// The routes read the person from the request; here the test says who that is.
const current = vi.hoisted(() => ({ session: null as unknown, language: "en" as string }));
vi.mock("@/server/auth", async (original) => ({ ...(await original<object>()), requireSession: async () => current.session }));
vi.mock("@/server/i18n", async (original) => ({
  ...(await original<object>()),
  getLanguage: async () => current.language,
  getT: async () => translatorFor(current.language as Language),
  localizeServerMessage: async (message: string) => translateServerMessage(message, current.language as Language),
}));

const db = setupTestDatabase();
let shop: TestShop;
const key = () => crypto.randomUUID().replace(/-/g, "");
const as = async (user: "owner" | "cashier") => (await signInAs(shop.users[user])).session as SessionContext;

beforeAll(async () => {
  shop = await createTestShop(db);
});

const hindiError = async (work: Promise<unknown>) => {
  const error = await work.then(() => null, (caught: unknown) => caught);
  expect(error).not.toBeNull();
  return translateServerMessage((await toActionError(error)).error, "hi");
};

async function download(language: Language, work: () => Promise<Response>) {
  current.language = language;
  const response = await work();
  expect(response.status).toBe(200);
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  return new TextDecoder("utf-8", { ignoreBOM: false }).decode(bytes);
}

const report = (kind: string, language: Language) => download(language, () => reportCsv(new Request(`http://local/reports/${kind}/csv?range=today`), { params: Promise.resolve({ kind }) }));

describe("CSV downloads in every language", () => {
  it("customer statement: headings and Nexora's words change; and amounts do not", async () => {
    current.session = await as("owner");
    const session = current.session as SessionContext;
    const { id } = await createCustomer(session, { name: "Refund Traders", phone: "", type: "retail", creditLimit: "5000", openingOwed: "1000", oldestBillDate: "2026-04-01" });
    await recordCustomerReceipt(session, { idempotencyKey: key(), customerId: id, amount: "300", method: "upi", reference: "UTR-CSV" });
    const get = () => statementCsv(new Request(`http://local/customers/${id}/statement/csv`), { params: Promise.resolve({ customerId: id }) });

    const english = await download("en", get);
    expect(english.split("\r\n")[0]).toBe(`"Date","Entry","Debit","Credit","Balance"`);

    const hindi = await download("hi", get);
    const t = translatorFor("hi");
    expect(hindi.split("\r\n")[0]).toBe([t("common.date"), t("csv.entry"), t("csv.debit"), t("csv.credit"), t("csv.balance")].map((word) => `"${word}"`).join(","));
    expect(hindi).toContain(`"1000.00"`);
    expect(hindi).toContain(`"700.00"`);

    const hinglish = await download("hinglish", get);
    expect(hinglish.split("\r\n")[0]).not.toBe(english.split("\r\n")[0]);
    expect(hinglish).not.toMatch(/[ऀ-ॿ]/);
    const amounts = (csv: string) => csv.split("\r\n").slice(1).map((line) => line.split(",").slice(-3).join());
    expect(amounts(hindi)).toEqual(amounts(english));
    expect(amounts(hinglish)).toEqual(amounts(english));
  });

  it("stock report", async () => {
    current.session = await as("owner");
    const session = current.session as SessionContext;
    const product = await createProduct(session, { name: "Elbow Bazaar", sku: "ELB-CSV", baseUnit: "pc", hsn: "3917", gstRateBp: "1800", retailPaise: "100", wholesalePaise: "90", costPaise: "50", reorderLevel: "5" });
    await recordOpeningStock(session, { idempotencyKey: key(), movementDate: indiaDate(), lines: [{ productId: product.id, unit: "pc", quantity: "1" }] } as never);
    const t = translatorFor("hi");
    const csv = await report("stock", "hi");
    const [head] = csv.split("\r\n");
    expect(head).toBe([t("common.product"), t("report.stock.sku"), t("common.status"), t("report.stock.inStock"), t("report.stock.reorder"), t("common.unit")].map((word) => `"${word}"`).join(","));
    expect(csv).toContain("Elbow Bazaar");
    expect(csv).toContain("ELB-CSV");
    expect(csv).toContain(`"पीस"`);
    expect(csv).not.toMatch(/Out of stock|Needs checking|Reorder now/);
    expect((await report("stock", "hinglish")).split("\r\n")[0]).toContain(translatorFor("hinglish")("common.product"));
  });

  it.each(["sales", "collections", "returns", "expenses", "products", "customer-dues", "supplier-dues"])("%s report headings, in Hindi and Hinglish, on the same rows", async (kind) => {
    current.session = await as("owner");
    const english = await report(kind, "en");
    const hindi = await report(kind, "hi");
    const hinglish = await report(kind, "hinglish");
    const head = (csv: string) => csv.split("\r\n")[0]!;
    expect(head(hindi)).toMatch(/[ऀ-ॿ]/);
    expect(head(hindi).replace(/"(GST|UPI)"/g, "")).not.toMatch(/[A-Za-z]{2,}/);
    expect(head(hinglish)).not.toBe(head(english));
    expect(head(hinglish)).not.toMatch(/[ऀ-ॿ]/);
    expect(hindi.split("\r\n").length).toBe(english.split("\r\n").length);
  });

  it("a report row keeps its entered note, and its status and category change", async () => {
    current.session = await as("owner");
    const session = current.session as SessionContext;
    await recordExpense(session, { idempotencyKey: key(), businessDate: indiaDate(), category: "other", amount: "45", method: "upi", note: "Diwali diye", reference: "" });
    const csv = await report("expenses", "hi");
    expect(csv).toContain("Diwali diye");
    expect(csv).toContain(`"अन्य"`);
    expect(csv).toContain(`"दर्ज"`);
    expect(csv).toContain(`"45.00"`);
    expect(csv).not.toContain("Recorded");
  });

  it("a report you may not open reads in your language", async () => {
    current.language = "hi";
    current.session = await as("owner");
    const response = await reportCsv(new Request("http://local/reports/nope/csv"), { params: Promise.resolve({ kind: "nope" }) });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("ऐसी कोई रिपोर्ट नहीं है।");
  });
});

describe("cashbook messages", () => {
  it("refusals read in Hindi and save nothing; closing and reopening keep every figure exact", async () => {
    const session = await as("owner");
    const today = indiaDate();
    const expense = await recordExpense(session, { idempotencyKey: key(), businessDate: today, category: "tea", amount: "40", method: "cash", note: "", reference: "" });
    const before = await getCashbook(session, today);

    expect(await hindiError(recordExpense(session, { idempotencyKey: key(), businessDate: today, category: "tea", amount: "0", method: "cash", note: "", reference: "" }))).toBe("राशि रुपये में डालें, 0 से ज़्यादा।");
    expect(await hindiError(recordExpense(session, { idempotencyKey: key(), businessDate: today, category: "other", amount: "5", method: "cash", note: "", reference: "" }))).toMatch(/[ऀ-ॿ]/);
    expect(await hindiError(recordExpense(session, { idempotencyKey: key(), businessDate: "2099-01-01", category: "tea", amount: "5", method: "cash", note: "", reference: "" }))).toBe("तारीख आगे की नहीं हो सकती।");
    expect(await hindiError(voidExpense(session, expense.id, { reason: "x" }))).toMatch(/[ऀ-ॿ]/);
    expect(await hindiError(reopenDay(session, today, { reason: "galti hui" }))).toBe("यह दिन बंद नहीं है।");
    expect((await getCashbook(session, today)).expectedPaise).toBe(before.expectedPaise);

    const off = (before.expectedPaise + 10000) / 100;
    expect(await hindiError(closeDay(session, { businessDate: today, counted: String(off), reasonKey: "", reasonNote: "" }))).toBe("नकद ₹100.00 ज़्यादा है। बंद करने से पहले कारण चुनें।");
    await closeDay(session, { businessDate: today, counted: String(off), reasonKey: "other", reasonNote: "Galle mein mila" });
    const closed = await getCashbook(session, today);
    expect(closed.closing).toMatchObject({ differencePaise: 10000, differenceReason: "Other: Galle mein mila" });
    expect(await hindiError(closeDay(session, { businessDate: today, counted: String(off), reasonKey: "other", reasonNote: "x" }))).toBe("यह दिन पहले से बंद है।");
    await reopenDay(session, today, { reason: "Dobara ginna hai" });
  });
});

describe("approvals", () => {
  it("request, decision and every refusal read in Hindi; saved words stay as they were", async () => {
    const owner = await as("owner");
    const cashier = await as("cashier");
    const { id: customerId } = await createCustomer(owner, { name: "Verma", phone: "", type: "retail", creditLimit: "100" });
    const ask = (reason: string) => requestApproval(cashier, { action: "credit_over_limit", targetRef: customerId, targetLabel: "Verma", reason, amountPaise: 500000, limitBp: null, quantity: null });

    expect(await hindiError(requestApproval(owner, { action: "credit_over_limit", targetRef: customerId, targetLabel: "Verma", reason: "direct", amountPaise: 500000, limitBp: null, quantity: null }))).toBe("मालिक यह सीधे कर सकते हैं; मंज़ूरी की ज़रूरत नहीं।");
    expect(await hindiError(ask("x"))).toMatch(/[ऀ-ॿ]/);

    const first = await ask("Purana grahak hai");
    expect(first.duplicate).toBe(false);
    expect(translateServerMessage(first.notification.note, "hi")).toMatch(/^मालिक को Nexora में सूचना/);
    expect(first.actionLabel).toBe("Credit above limit");

    expect(await hindiError(decideApproval(cashier, { approvalId: first.id, decision: "approve" }))).toMatch(/[ऀ-ॿ]/);
    expect(await hindiError(decideApproval(owner, { approvalId: first.id, decision: "reject", reason: "" }))).toBe("लिखें यह अनुरोध मना क्यों कर रहे हैं।");
    expect((await decideApproval(owner, { approvalId: first.id, decision: "reject", reason: "Bahut baaki hai" })).status).toBe("rejected");
    expect(await hindiError(decideApproval(owner, { approvalId: first.id, decision: "approve" }))).toBe("यह अनुरोध पहले ही मना हो चुका है।");

    const second = await ask("Dobara poochh raha hoon");
    expect((await decideApproval(owner, { approvalId: second.id, decision: "approve" })).status).toBe("approved");
    expect(await hindiError(decideApproval(owner, { approvalId: second.id, decision: "reject", reason: "Bahut baaki hai" }))).toBe("यह अनुरोध पहले ही मंज़ूर हो चुका है।");

    const saved = await listApprovals(owner, { status: "all" });
    expect(saved.find((row) => row.id === first.id)).toMatchObject({ action: "credit_over_limit", reason: "Purana grahak hai", decisionReason: "Bahut baaki hai", targetLabel: "Verma" });
  });
});
