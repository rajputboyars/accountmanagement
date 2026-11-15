import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { accountBalances, activateBusinessAccounts, confirmOpeningBalances, ensureChart, getAccountingStatus, postJournal, recordOpeningBalances, reverseJournal, setInputGstPolicy } from "@/modules/accounting";
import { accountingGaps, accounts, journals } from "@/modules/accounting/schema";
import { auditLog } from "@/modules/audit/schema";
import { createCustomer } from "@/modules/parties";
import { createSupplier } from "@/modules/purchasing";
import { toActionError } from "@/server/action-result";
import { withTransaction } from "@/server/db";
import { CHART, goodsReceived, invoiceCost, invoiceIssued, paymentRecorded, type JournalDraft } from "@/shared/accounting";
import { indiaDate } from "@/shared/financial-year";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

/** Business Accounts foundation: opt-in, balanced and immutable journals, idempotent posting, reversals, opening balances. */
const db = setupTestDatabase();
let shop: TestShop;
let other: TestShop;
const as = async (target: TestShop, role: keyof TestShop["users"]) => (await signInAs(target.users[role])).session;
const uuid = () => crypto.randomUUID();
const today = indiaDate();
const START = "2026-04-01";
const refusal = async (work: Promise<unknown>) => {
  const error = await work.then(() => null, (caught: unknown) => caught);
  expect(error, "should be refused").not.toBeNull();
  return (await toActionError(error)).error;
};
const ctxOf = (target: TestShop) => ({ shopId: target.shopId, userId: target.users.owner.id });
const post = (target: TestShop, input: { entryDate: string; sourceId?: string; draft: JournalDraft; sourceType?: string }) =>
  withTransaction((tx) => postJournal(tx, ctxOf(target), { sourceType: input.sourceType ?? "invoice", sourceId: input.sourceId ?? uuid(), ...input }));
const invoice = (customerId: string, total = 11800) => invoiceIssued({ customerId, taxablePaise: 10000, gstPaise: 1800, roundOffPaise: total - 11800, totalPaise: total });
const journalCount = async (target: TestShop) => (await db.owner.select().from(journals).where(eq(journals.shopId, target.shopId))).length;
const net = async (target: TestShop, key: string) => {
  const owner = await as(target, "owner");
  const row = (await accountBalances(owner)).find((entry) => entry.systemKey === key);
  return (row?.debitPaise ?? 0) - (row?.creditPaise ?? 0);
};

beforeAll(async () => {
  shop = await createTestShop(db, "Books Shop");
  other = await createTestShop(db, "Other Books Shop");
});

describe("opt-in", () => {
  it("posts nothing and shows 'not active' until the owner turns Business Accounts on", async () => {
    const result = await post(shop, { entryDate: today, draft: invoice(uuid()) });
    expect(result).toEqual({ status: "skipped", reason: "not_active" });
    expect(await journalCount(shop)).toBe(0);
    const status = await getAccountingStatus(await as(shop, "owner"));
    expect(status).toMatchObject({ active: false, complete: false, incompleteReasons: ["not_active"] });
  });

  it("is for the owner only: managers and cashiers can neither turn it on nor see the books", async () => {
    for (const role of ["manager", "cashier", "inventory"] as const) {
      const session = await as(shop, role);
      await expect(activateBusinessAccounts(session, { coverageStartDate: START })).rejects.toThrow();
      await expect(getAccountingStatus(session)).rejects.toThrow();
      await expect(accountBalances(session)).rejects.toThrow();
    }
  });

  it("sets up the chart once, refuses a future or invalid start and a second activation", async () => {
    const owner = await as(shop, "owner");
    expect(await refusal(activateBusinessAccounts(owner, { coverageStartDate: "2999-01-01" }))).toContain("future");
    await expect(activateBusinessAccounts(owner, { coverageStartDate: "2026-02-30" })).rejects.toThrow();
    await activateBusinessAccounts(owner, { coverageStartDate: START });
    expect(await db.owner.select().from(accounts).where(eq(accounts.shopId, shop.shopId))).toHaveLength(CHART.length);
    await withTransaction((tx) => ensureChart(tx, shop.shopId));
    expect(await db.owner.select().from(accounts).where(eq(accounts.shopId, shop.shopId))).toHaveLength(CHART.length);
    expect(await refusal(activateBusinessAccounts(owner, { coverageStartDate: START }))).toContain("already on");
    expect((await db.owner.select().from(auditLog).where(eq(auditLog.shopId, shop.shopId))).some((row) => row.action === "accounting.activated")).toBe(true);
    await activateBusinessAccounts(await as(other, "owner"), { coverageStartDate: START });
  });
});

describe("posting", () => {
  it("posts a balanced journal and treats a repeat of the same document as a no-op", async () => {
    const sourceId = uuid();
    const customerId = uuid();
    const first = await post(shop, { entryDate: today, sourceId, draft: invoice(customerId) });
    expect(first.status).toBe("posted");
    const before = await journalCount(shop);
    const again = await post(shop, { entryDate: today, sourceId, draft: invoice(customerId) });
    expect(again).toEqual({ status: "duplicate", journalId: first.status === "posted" ? first.journalId : "" });
    expect(await journalCount(shop)).toBe(before);
  });

  it("returns the same journal when exactly the same document is posted again, even at the same moment", async () => {
    const customerId = uuid();
    const sourceId = uuid();
    const results = await Promise.all([post(shop, { entryDate: today, sourceId, draft: invoice(customerId) }), post(shop, { entryDate: today, sourceId, draft: invoice(customerId) })]);
    expect(results.map((entry) => entry.status).sort()).toEqual(["duplicate", "posted"]);
    expect(new Set(results.map((entry) => (entry.status === "skipped" ? "" : entry.journalId))).size).toBe(1);
    expect((await db.owner.select().from(journals).where(eq(journals.sourceId, sourceId))).length).toBe(1);
  });

  it("refuses a changed document that was already posted and says to reverse it", async () => {
    const sourceId = uuid();
    const customerId = uuid();
    await post(shop, { entryDate: today, sourceId, draft: invoice(customerId, 11800) });
    const text = await refusal(post(shop, { entryDate: today, sourceId, draft: invoice(customerId, 11820) }));
    expect(text).toContain("Reverse it and post it again");
  });

  it("leaves out anything dated before the books start", async () => {
    const result = await post(shop, { entryDate: "2026-03-31", draft: invoice(uuid()) });
    expect(result).toEqual({ status: "skipped", reason: "before_coverage" });
  });

  it("rolls the journal back with the business event that posted it", async () => {
    const sourceId = uuid();
    await expect(
      withTransaction(async (tx) => {
        await postJournal(tx, ctxOf(shop), { entryDate: today, sourceType: "invoice", sourceId, draft: invoice(uuid()) });
        throw new Error("the sale failed after posting");
      }),
    ).rejects.toThrow("the sale failed");
    expect(await db.owner.select().from(journals).where(eq(journals.sourceId, sourceId))).toHaveLength(0);
  });

  it("refuses to post inside a locked period", async () => {
    await db.ownerPool.query("update accounting_settings set lock_through = $1 where shop_id = $2", ["2026-06-30", shop.shopId]);
    try {
      expect(await refusal(post(shop, { entryDate: "2026-06-30", draft: invoice(uuid()) }))).toContain("locked");
      expect((await post(shop, { entryDate: "2026-07-01", draft: invoice(uuid()) })).status).toBe("posted");
    } finally {
      await db.ownerPool.query("update accounting_settings set lock_through = null where shop_id = $1", [shop.shopId]);
    }
  });
});

describe("balanced and immutable", () => {
  it("refuses an unbalanced journal before it reaches the database", async () => {
    const draft: JournalDraft = { event: "invoice", gaps: [], lines: [{ account: "receivables", debitPaise: 100, creditPaise: 0 }, { account: "sales", debitPaise: 0, creditPaise: 99 }] };
    expect(await refusal(post(shop, { entryDate: today, draft }))).toContain("does not balance");
  });

  it("refuses an unbalanced, one-line or foreign-account journal at the database even if the application is bypassed", async () => {
    const [cash] = await db.owner.select().from(accounts).where(eq(accounts.shopId, shop.shopId));
    const [foreign] = await db.owner.select().from(accounts).where(eq(accounts.shopId, other.shopId));
    const attempt = async (lines: { account: string; shop?: string; debit: number; credit: number }[]) => {
      const client = await db.ownerPool.connect();
      try {
        await client.query("begin");
        const journal = (await client.query("insert into journals (id, shop_id, entry_date, kind, source_type, source_id, event) values (gen_random_uuid(), $1, $2, 'event', 'raw', gen_random_uuid(), 'raw') returning id", [shop.shopId, today])).rows[0].id;
        for (const line of lines) await client.query("insert into journal_lines (journal_id, shop_id, account_id, debit_paise, credit_paise) values ($1, $2, $3, $4, $5)", [journal, line.shop ?? shop.shopId, line.account, line.debit, line.credit]);
        await client.query("commit");
        return "committed";
      } catch (error) {
        await client.query("rollback");
        return (error as Error).message;
      } finally {
        client.release();
      }
    };
    expect(await attempt([{ account: cash!.id, debit: 100, credit: 0 }, { account: cash!.id, debit: 0, credit: 90 }])).toContain("does not balance");
    expect(await attempt([{ account: cash!.id, debit: 100, credit: 0 }])).toContain("at least two lines");
    expect(await attempt([{ account: cash!.id, debit: 100, credit: 0 }, { account: foreign!.id, debit: 0, credit: 100 }])).toContain("another shop");
    expect(await attempt([{ account: cash!.id, debit: 100, credit: 0 }, { account: cash!.id, debit: 0, credit: 100 }])).toBe("committed");
  });

  it("never lets a posted journal, line, gap or account identity be changed or removed", async () => {
    await post(shop, { entryDate: today, draft: invoice(uuid()) });
    for (const statement of [
      "update journals set memo = 'x' where shop_id = $1",
      "delete from journals where shop_id = $1",
      "update journal_lines set debit_paise = debit_paise where shop_id = $1",
      "delete from journal_lines where shop_id = $1",
      "update accounts set code = '9999' where shop_id = $1",
      "update accounts set cash_flow = 'none' where shop_id = $1",
      "delete from accounts where shop_id = $1",
    ]) await expect(db.ownerPool.query(statement, [shop.shopId]), statement).rejects.toThrow();
    await expect(db.ownerPool.query("truncate journals cascade")).rejects.toThrow();
    await expect(db.ownerPool.query("update accounts set name = 'Cash drawer' where shop_id = $1 and system_key = 'cash'", [shop.shopId])).resolves.toBeDefined();
  });
});

describe("reversals", () => {
  it("posts the mirror image, never touches the original, and is idempotent", async () => {
    const owner = await as(shop, "owner");
    const customerId = uuid();
    const before = await net(shop, "receivables");
    const posted = await post(shop, { entryDate: today, draft: invoice(customerId) });
    if (posted.status !== "posted") throw new Error("expected posted");
    expect(await net(shop, "receivables")).toBe(before + 11800);
    const first = await withTransaction((tx) => reverseJournal(tx, ctxOf(shop), { journalId: posted.journalId, entryDate: today, memo: "Invoice cancelled" }));
    expect(first.status).toBe("posted");
    expect(await net(shop, "receivables")).toBe(before);
    const second = await withTransaction((tx) => reverseJournal(tx, ctxOf(shop), { journalId: posted.journalId, entryDate: today }));
    expect(second).toEqual({ status: "duplicate", journalId: first.status === "posted" ? first.journalId : "" });
    const [original] = await db.owner.select().from(journals).where(eq(journals.id, posted.journalId));
    expect(original?.memo).toBeNull();
    const lines = (await accountBalances(owner)).filter((row) => row.systemKey === "gst_output");
    expect(lines[0]!.debitPaise).toBeGreaterThanOrEqual(1800);
  });

  it("cannot reverse a reversal or an opening journal, or another shop's journal", async () => {
    const posted = await post(shop, { entryDate: today, draft: invoice(uuid()) });
    if (posted.status !== "posted") throw new Error("expected posted");
    const reversal = await withTransaction((tx) => reverseJournal(tx, ctxOf(shop), { journalId: posted.journalId, entryDate: today }));
    if (reversal.status !== "posted") throw new Error("expected reversal");
    await expect(withTransaction((tx) => reverseJournal(tx, ctxOf(shop), { journalId: reversal.journalId, entryDate: today }))).rejects.toThrow();
    await expect(withTransaction((tx) => reverseJournal(tx, ctxOf(other), { journalId: posted.journalId, entryDate: today }))).rejects.toThrow("not found");
  });
});

describe("incomplete books are never shown as complete", () => {
  it("records a gap for a sale line with no cost, once, and lists it as open", async () => {
    const sourceId = uuid();
    const draft = invoiceCost({ lines: [{ productId: uuid(), qtyBase: "2.000", unitCostPaise: null }] });
    const result = await post(shop, { entryDate: today, sourceId, draft });
    expect(result).toEqual({ status: "skipped", reason: "nothing_to_post" });
    await post(shop, { entryDate: today, sourceId, draft });
    expect(await db.owner.select().from(accountingGaps).where(eq(accountingGaps.sourceId, sourceId))).toHaveLength(1);
    const status = await getAccountingStatus(await as(shop, "owner"));
    expect(status.complete).toBe(false);
    expect(status.incompleteReasons).toContain("gaps_open");
    expect(status.openGaps.find((gap) => gap.kind === "cost_missing_for_sale")?.count).toBeGreaterThanOrEqual(1);
  });

  it("lets a gap be marked resolved but never edited or deleted", async () => {
    const [gap] = await db.owner.select().from(accountingGaps).where(eq(accountingGaps.shopId, shop.shopId));
    await expect(db.ownerPool.query("update accounting_gaps set note = 'changed' where id = $1", [gap!.id])).rejects.toThrow("only resolved");
    await expect(db.ownerPool.query("delete from accounting_gaps where id = $1", [gap!.id])).rejects.toThrow();
  });
});

describe("opening balances", () => {
  const rows = { inventoryPaise: 500000, cashPaise: 20000, bankPaise: 80000, upiPaise: 0, cardPaise: 0, chequesPaise: 15000, other: [], unvaluedProductIds: [] as string[] };
  let customerId: string;
  let supplierId: string;

  it("is refused before it is entered, and for parties from another business", async () => {
    const owner = await as(shop, "owner");
    await expect(confirmOpeningBalances(owner)).rejects.toThrow("opening balances first");
    customerId = (await createCustomer(owner, { name: "Opening Customer", phone: "9410000001", type: "retail", creditLimit: "1000" })).id;
    supplierId = (await createSupplier(owner, { name: "Opening Supplier", phone: "", gstin: "", paymentTermsDays: "30" })).id;
    const foreign = (await createCustomer(await as(other, "owner"), { name: "Other Customer", phone: "9410000002", type: "retail", creditLimit: "1000" })).id;
    expect(await refusal(recordOpeningBalances(owner, { ...rows, receivables: [{ partyId: foreign, balancePaise: 100 }], payables: [] }))).toContain("do not belong");
    expect(await db.owner.select().from(journals).where(eq(journals.kind, "opening"))).toHaveLength(0);
  });

  it("is dated the day before the books start, holds the balancing figure in clearing, and flags the books unverified", async () => {
    const owner = await as(shop, "owner");
    const result = await recordOpeningBalances(owner, { ...rows, receivables: [{ partyId: customerId, balancePaise: 60000 }], payables: [{ partyId: supplierId, balancePaise: -30000 }] });
    expect(result.clearingBalancePaise).toBe(-(500000 + 20000 + 80000 + 15000 + 60000 - 30000));
    const [opening] = await db.owner.select().from(journals).where(eq(journals.id, result.journalId!));
    expect(opening).toMatchObject({ entryDate: "2026-03-31", kind: "opening" });
    const status = await getAccountingStatus(owner);
    expect(status).toMatchObject({ openingRecorded: true, openingStatus: "unverified" });
    expect(status.incompleteReasons).toEqual(expect.arrayContaining(["opening_unverified", "clearing_not_zero"]));
    expect(await net(shop, "owner_capital")).toBe(0);
    expect(await refusal(recordOpeningBalances(owner, { ...rows, receivables: [], payables: [] }))).toContain("already recorded");
  });

  it("keeps the parties on the control accounts so they tie to the party ledger", async () => {
    const result = await db.ownerPool.query("select party_type, party_id, debit_paise, credit_paise from journal_lines l join accounts a on a.id = l.account_id where a.system_key in ('receivables','payables') and l.party_id in ($1, $2) and l.shop_id = $3 order by party_type", [customerId, supplierId, shop.shopId]);
    expect(result.rows.map((row) => [row.party_type, Number(row.debit_paise), Number(row.credit_paise)])).toEqual([["customer", 60000, 0], ["supplier", 0, 30000]]);
  });

  it("moves the clearing balance to owner's capital only when the owner confirms, once", async () => {
    const owner = await as(shop, "owner");
    const manager = await as(shop, "manager");
    await expect(confirmOpeningBalances(manager)).rejects.toThrow();
    const confirmed = await confirmOpeningBalances(owner);
    expect(confirmed.movedToCapitalPaise).toBe(500000 + 20000 + 80000 + 15000 + 60000 - 30000);
    expect(await net(shop, "opening_clearing")).toBe(0);
    expect(await net(shop, "owner_capital")).toBe(-confirmed.movedToCapitalPaise);
    expect(await confirmOpeningBalances(owner)).toEqual({ movedToCapitalPaise: 0 });
    expect((await getAccountingStatus(owner)).openingStatus).toBe("verified");
  });

  it("clears each reason in turn, and the input GST choice is explicit and owner-only", async () => {
    const owner = await as(shop, "owner");
    await db.ownerPool.query("update accounting_gaps set resolved_at = now() where shop_id = $1", [shop.shopId]);
    const reasons = (await getAccountingStatus(owner)).incompleteReasons;
    expect(reasons).toContain("input_gst_review");
    expect(reasons).not.toContain("gaps_open");
    expect(reasons).not.toContain("opening_unverified");
    expect(reasons).not.toContain("clearing_not_zero");
    await setInputGstPolicy(owner, "recoverable");
    const after = await getAccountingStatus(owner);
    expect(after.inputGstPolicy).toBe("recoverable");
    expect(after.incompleteReasons).not.toContain("input_gst_review");
    await expect(setInputGstPolicy(owner, "whatever")).rejects.toThrow();
    await expect(setInputGstPolicy(await as(shop, "manager"), "review")).rejects.toThrow();
  });

  it("posts later purchases to the chosen input GST account and keeps debits equal to credits across the books", async () => {
    await post(shop, { entryDate: today, sourceType: "goods_receipt", draft: goodsReceived({ supplierId, taxablePaise: 100000, gstPaise: 18000, totalPaise: 118000, inputGstPolicy: "recoverable" }) });
    expect(await net(shop, "gst_input_recoverable")).toBe(18000);
    expect(await net(shop, "gst_input_review")).toBe(0);
    const all = await accountBalances(await as(shop, "owner"));
    expect(all.reduce((sum, row) => sum + row.debitPaise, 0)).toBe(all.reduce((sum, row) => sum + row.creditPaise, 0));
    await post(shop, { entryDate: today, sourceType: "payment", draft: paymentRecorded({ direction: "out", partyType: "supplier", partyId: supplierId, method: "upi", amountPaise: 5000 }) });
    expect(await net(shop, "upi")).toBe(-5000);
    expect(await net(shop, "bank")).toBe(80000);
  });
});

describe("shop isolation", () => {
  it("keeps one business's books, balances and status out of another's", async () => {
    const otherOwner = await as(other, "owner");
    expect(await journalCount(other)).toBe(0);
    expect((await accountBalances(otherOwner)).every((row) => row.debitPaise === 0 && row.creditPaise === 0)).toBe(true);
    expect((await getAccountingStatus(otherOwner)).openingRecorded).toBe(false);
    expect(await net(other, "receivables")).toBe(0);
  });
});
