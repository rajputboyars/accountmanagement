import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checklistMode, stepHint, type TodaySummary } from "@/components/nexora/setup-checklist";
import { createProduct, shopHasProducts } from "@/modules/catalog";
import { recordOpeningStock } from "@/modules/inventory";
import { getDashboard, getOnboarding } from "@/modules/reporting";
import { cancelInvoice, createInvoice, previewBill, shopHasInvoices, type BillInput } from "@/modules/sales";
import { updateBusinessProfile } from "@/modules/settings";
import { indiaDate } from "@/shared/financial-year";
import { createTestShop, signInAs } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
type Session = Awaited<ReturnType<typeof signInAs>>["session"];
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
let n = 0;

async function sell(session: Session, input: BillInput) {
  const preview = await previewBill(session, input);
  return createInvoice(session, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates });
}
const done = async (session: Session) => Object.fromEntries((await getOnboarding(session)).steps.map((step) => [step.key, step.done]));

describe("first-run setup checklist", () => {
  it("ticks off business details, first product and first bill from the shop's real records", async () => {
    n += 1;
    const shop = await createTestShop(db, `Onboarding ${n}`);
    const other = await createTestShop(db, `Onboarding other ${n}`);
    const owner = (await signInAs(shop.users.owner)).session;
    const outsider = (await signInAs(other.users.owner)).session;

    expect(await getOnboarding(owner)).toMatchObject({ doneCount: 0, complete: false, hasBills: false });
    await updateBusinessProfile(owner, { name: `Onboarding ${n}`, address: "", phone: "98290 12345", stateCode: "08" });
    expect((await done(owner)).business).toBe(false); // address still missing
    await updateBusinessProfile(owner, { name: `Onboarding ${n}`, address: "12 MI Road, Jaipur", phone: "98290 12345", stateCode: "08" });
    expect(await done(owner)).toEqual({ business: true, product: false, bill: false });

    const { id } = await createProduct(owner, { name: `Tap ${n}`, sku: `OB-${n}`, baseUnit: "pc", hsn: "8481", gstRateBp: "0", retailPaise: "100", wholesalePaise: "90", costPaise: "60" });
    await recordOpeningStock(owner, { idempotencyKey: key(), movementDate: indiaDate(), lines: [{ productId: id, unit: "pc", quantity: "10" }] });
    expect(await done(owner)).toEqual({ business: true, product: true, bill: false });

    const bill = await sell(owner, { lines: [{ productId: id, unit: "pc", quantity: "1" }], payments: { cash: "100" } });
    expect(await getOnboarding(owner)).toMatchObject({ doneCount: 3, complete: true, hasBills: true });
    // A cancelled first bill still means the owner has billed: the checklist doesn't go backwards.
    await cancelInvoice(owner, bill.id, { reason: "Practice bill" });
    expect(await getOnboarding(owner)).toMatchObject({ complete: true, hasBills: true });

    // Another shop's progress is its own.
    expect(await getOnboarding(outsider)).toMatchObject({ doneCount: 0, hasBills: false });
    expect([await shopHasProducts(other.shopId), await shopHasInvoices(other.shopId)]).toEqual([false, false]);
  });

  it("only offers each step to people allowed to do it", async () => {
    n += 1;
    const shop = await createTestShop(db, `Onboarding roles ${n}`);
    const canAct = async (role: "owner" | "cashier" | "inventory") => Object.fromEntries((await getOnboarding((await signInAs(shop.users[role])).session)).steps.map((step) => [step.key, step.canAct]));
    expect(await canAct("owner")).toEqual({ business: true, product: true, bill: true });
    expect(await canAct("cashier")).toEqual({ business: false, product: false, bill: true });
    const cashierSteps = (await getOnboarding((await signInAs(shop.users.cashier)).session)).steps;
    expect(stepHint(cashierSteps.find((step) => step.key === "business")!)).toBe("Ask the owner to do this.");
    expect(stepHint(cashierSteps.find((step) => step.key === "bill")!)).toContain("udhaar");
  });

  it("shows steps until setup is done, then today's summary only on the today view", () => {
    const steps = (doneCount: number) => ({ steps: [], doneCount, complete: doneCount === 3, hasBills: doneCount === 3 });
    const today: TodaySummary = { billedPaise: 10000, billCount: 1, collectedPaise: 10000, receivablePaise: 0, expensesPaise: 0, profit: { reliable: false } };
    expect(checklistMode(steps(1), today)).toBe("steps");
    expect(checklistMode(steps(3), today)).toBe("done");
    expect(checklistMode(steps(3), null)).toBe("hidden");
  });
});

describe("dashboard for a new shop", () => {
  it("shows real zeros, not invented figures, and no profit claim it can't back", async () => {
    n += 1;
    const shop = await createTestShop(db, `Empty ${n}`);
    const owner = (await signInAs(shop.users.owner)).session;
    const dash = await getDashboard(owner);
    expect(dash.sales).toMatchObject({ billCount: 0, billedPaise: 0 });
    expect(dash.money.collectedPaise).toBe(0);
    expect(dash.receivables?.receivablePaise).toBe(0);
    expect(dash.expenses).toEqual({ totalPaise: 0, byCategory: [] });
    expect(dash.recent).toEqual([]);
    expect(dash.topProducts).toEqual([]);

    // A sale of an item without a cost price: profit is "not available", never a guess.
    const { id } = await createProduct(owner, { name: `No cost ${n}`, sku: `NC-${n}`, baseUnit: "pc", hsn: "8481", gstRateBp: "0", retailPaise: "100", wholesalePaise: "90", costPaise: "" });
    await recordOpeningStock(owner, { idempotencyKey: key(), movementDate: indiaDate(), lines: [{ productId: id, unit: "pc", quantity: "5" }] });
    await sell(owner, { lines: [{ productId: id, unit: "pc", quantity: "1" }], payments: { cash: "100" } });
    expect((await getDashboard(owner)).profit).toMatchObject({ reliable: false });
  });
});
