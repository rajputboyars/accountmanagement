import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createProduct } from "@/modules/catalog";
import { recordOpeningStock } from "@/modules/inventory";
import { cancelInvoice, createInvoice, createReturn, previewBill, previewReturn, getInvoice, getReturnableInvoice } from "@/modules/sales";
import { isAppError } from "@/server/errors";
import { indiaDate } from "@/shared/financial-year";
import { translateServerMessage, type Language } from "@/shared/i18n";
import { rateReasonLabel, systemName } from "@/shared/i18n/labels";
import { paiseToRupeeInput } from "@/shared/money";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
let shop: TestShop;
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const owner = async () => (await signInAs(shop.users.owner)).session;
const LANGUAGES_TESTED: Language[] = ["en", "hinglish", "hi"];

let productId: string;

/** A bill or return refusal must read properly in every language, and the record must not depend on language. */
function expectTranslated(english: string) {
  expect(translateServerMessage(english, "en")).toBe(english);
  expect(translateServerMessage(english, "hinglish"), english).not.toBe(english);
  expect(translateServerMessage(english, "hi"), english).toMatch(/[ऀ-ॿ]/);
  for (const language of LANGUAGES_TESTED) expect(translateServerMessage(english, language)).not.toMatch(/\{\w+\}/);
}

async function refusal(run: () => Promise<unknown>): Promise<{ message: string; details?: Record<string, unknown> }> {
  try {
    await run();
  } catch (error) {
    if (isAppError(error)) return { message: error.message, details: error.details };
    if (error instanceof Error && "issues" in error) return { message: (error as unknown as { issues: { message: string }[] }).issues[0]!.message };
    throw error;
  }
  throw new Error("Expected a refusal");
}

const billInput = (quantity: string, cash = "") => ({ customerId: "", priceList: "", discountPercent: "", lines: [{ productId, unit: "pc", quantity }], payments: { cash, upi: "", card: "", bank: "" }, cashReceived: "", placeOfSupply: "" });

async function saveBill(quantity: string) {
  const session = await owner();
  const first = await previewBill(session, billInput(quantity));
  const input = billInput(quantity, paiseToRupeeInput(first.totals.totalPaise));
  const preview = await previewBill(session, input);
  expect(preview.problems).toEqual([]);
  return createInvoice(session, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates });
}

beforeAll(async () => {
  shop = await createTestShop(db);
  const session = await owner();
  ({ id: productId } = await createProduct(session, { name: "CPVC Pipe", sku: "CP-1", baseUnit: "pc", hsn: "3917", gstRateBp: "1800", retailPaise: "100", wholesalePaise: "90", costPaise: "50" }));
  await recordOpeningStock(session, { idempotencyKey: key(), movementDate: indiaDate(), lines: [{ productId, unit: "pc", quantity: "50" }] } as never);
});

describe("billing workflow messages in all three languages", () => {
  it("a bill refused for stock and missing customer explains itself, keeping the product name", async () => {
    const session = await owner();
    const preview = await previewBill(session, billInput("500"));
    expect(preview.problems.length).toBeGreaterThan(0);
    for (const problem of preview.problems) expectTranslated(problem.message);
    const stock = preview.problems.find((problem) => problem.message.includes("CPVC Pipe"))!;
    expect(translateServerMessage(stock.message, "hi")).toContain("CPVC Pipe");
    expect(translateServerMessage(stock.message, "hinglish")).toContain("CPVC Pipe");
  });

  it("the rate label of a real bill line reads in each language", async () => {
    const preview = await previewBill(await owner(), billInput("1"));
    const reason = preview.lines[0]!.rateReason;
    expect(rateReasonLabel(reason, "en")).toBe(reason);
    expect(rateReasonLabel(reason, "hi")).toBe("खुदरा");
    expect(rateReasonLabel(reason, "hinglish")).toBe("Retail");
  });

  it("a saved bill's walk-in name is shown translated while the record stays the same", async () => {
    const { id } = await saveBill("1");
    const invoice = await getInvoice(await owner(), id);
    expect(invoice.customer.name).toBe("Walk-in customer");
    expect(systemName(invoice.customer.name, "hi")).toBe("काउंटर ग्राहक");
  });

  it("cancelling twice and a too-short reason are translated refusals", async () => {
    const session = await owner();
    const { id } = await saveBill("1");
    expectTranslated((await refusal(() => cancelInvoice(session, id, { reason: "x" }))).message);
    await cancelInvoice(session, id, { reason: "galat maal" });
    expectTranslated((await refusal(() => cancelInvoice(session, id, { reason: "galat maal" }))).message);
  });

  it("an empty bill is a translated refusal", async () => {
    expectTranslated((await refusal(async () => previewBill(await owner(), { ...billInput("1"), lines: [] }))).message);
  });
});

describe("return workflow messages in all three languages", () => {
  it("returning too much is refused with translated page and field messages", async () => {
    const session = await owner();
    const { id } = await saveBill("2");
    const invoice = await getReturnableInvoice(session, id);
    const line = invoice.lines[0]!;
    const over = await refusal(() => previewReturn(session, { invoiceId: id, lines: [{ invoiceLineId: line.id, baseQty: "9", restock: true }], reason: "extra maal", settlement: "cash" }));
    expectTranslated(over.message);
    const fields = (over.details?.fieldErrors ?? {}) as Record<string, string>;
    for (const message of Object.values(fields)) expectTranslated(message);
  });

  it("a walk-in return can't reduce an account, and says so in each language", async () => {
    const session = await owner();
    const { id } = await saveBill("2");
    const invoice = await getReturnableInvoice(session, id);
    const refused = await refusal(() => previewReturn(session, { invoiceId: id, lines: [{ invoiceLineId: invoice.lines[0]!.id, baseQty: "1", restock: true }], reason: "extra maal", settlement: "ledger" }));
    expectTranslated(refused.message);
  });

  it("a real refund return saves the same record regardless of language, and a cancelled bill refuses returns", async () => {
    const session = await owner();
    const { id } = await saveBill("2");
    const invoice = await getReturnableInvoice(session, id);
    const input = { invoiceId: id, lines: [{ invoiceLineId: invoice.lines[0]!.id, baseQty: "1", restock: true }], reason: "extra maal", settlement: "cash" };
    const preview = await previewReturn(session, input);
    const saved = await createReturn(session, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totalPaise });
    expect(saved.id).toBeTruthy();

    const second = await saveBill("1");
    await cancelInvoice(session, second.id, { reason: "galat maal" });
    const secondLines = await getReturnableInvoice(session, second.id);
    expectTranslated((await refusal(() => previewReturn(session, { invoiceId: second.id, lines: [{ invoiceLineId: secondLines.lines[0]!.id, baseQty: "1", restock: true }], reason: "extra maal", settlement: "cash" }))).message);
  });
});
