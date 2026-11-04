import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { activateBusinessAccounts, accountBalances } from "@/modules/accounting";
import { journals } from "@/modules/accounting/schema";
import { addProductUnit, createProduct } from "@/modules/catalog";
import {
  createGodown,
  godownStock,
  listGodowns,
  listStock,
  listTransfers,
  rebuildStockCache,
  recordAdjustment,
  recordOpeningStock,
  renameGodown,
  setGodownActive,
  transferStock,
} from "@/modules/inventory";
import { godowns, stockLevels, stockMovements } from "@/modules/inventory/schema";
import { cancelInvoice, createInvoice, createReturn, getReturnableInvoice, previewBill, previewReturn, type BillInput } from "@/modules/sales";
import { cancelGoodsReceipt } from "@/modules/purchasing";
import { createSupplier } from "@/modules/purchasing";
import { toActionError } from "@/server/action-result";
import { indiaDate } from "@/shared/financial-year";
import { translateServerMessage } from "@/shared/i18n";
import { addDays } from "@/shared/report-range";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { receiveGoods } from "../helpers/purchasing";
import { setupTestDatabase } from "../helpers/test-db";

/** Phase 2: godowns (opt-in), per-godown stock, dispatch and receipt rules, reversals into the original godown, and transfers. */
const db = setupTestDatabase();
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const today = indiaDate();
type Session = Awaited<ReturnType<typeof signInAs>>["session"];
let counter = 0;

const refusal = async (work: Promise<unknown>) => {
  const error = await work.then(() => null, (caught: unknown) => caught);
  expect(error, "should be refused").not.toBeNull();
  return (await toActionError(error)).error;
};
const as = async (shop: TestShop, role: keyof TestShop["users"] = "owner") => (await signInAs(shop.users[role])).session;

async function newShop(name: string) {
  const shop = await createTestShop(db, name);
  return { shop, owner: await as(shop) };
}

/** A pipe sold by the piece and by the box of 12, cost ₹60. */
async function pipe(session: Session) {
  counter += 1;
  const { id } = await createProduct(session, { name: `Pipe ${counter}`, sku: `GD-${counter}`, baseUnit: "pc", hsn: "3917", gstRateBp: "0", retailPaise: "100", wholesalePaise: "90", costPaise: "60" });
  await addProductUnit(session, id, { unit: "box", factor: "12" });
  return id;
}

const stockIn = async (session: Session, godownId: string | undefined, productId: string, quantity: string) => {
  const supplier = await createSupplier(session, { name: `Supplier ${++counter}`, phone: "", gstin: "", paymentTermsDays: "30" });
  return receiveGoods(session, { idempotencyKey: key(), supplierId: supplier.id, supplierBillNo: `B-${counter}`, supplierBillDate: today, ...(godownId ? { godownId } : {}), lines: [{ productId, unit: "pc", quantity, cost: "60", gstRateBp: "0" }] });
};
const here = async (session: Session, godownId: string, productId: string) => Number((await godownStock(session, { godownId, productId }))[0]?.qty ?? 0);
const total = async (shopId: string, productId: string) => Number((await db.owner.execute(sql`select coalesce(sum(qty_base), 0)::text as q from v_stock where product_id = ${productId}`)).rows[0]?.q ?? 0);
const sell = async (session: Session, input: BillInput) => {
  const preview = await previewBill(session, input);
  return { preview, saved: preview.problems.length === 0 ? await createInvoice(session, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates }) : null };
};

describe("a shop with one godown sees nothing new", () => {
  it("keeps all stock in a silently created Main Store and asks no one for a godown", async () => {
    const { shop, owner } = await newShop("Single godown shop");
    const id = await pipe(owner);
    await stockIn(owner, undefined, id, "10");
    const places = await listGodowns(owner);
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ name: "Main Store", isDefault: true, isActive: true });
    expect(await here(owner, places[0]!.id, id)).toBe(10);
    // A bill needs no godown, and takes the goods from the Main Store.
    const { saved, preview } = await sell(owner, { lines: [{ productId: id, unit: "pc", quantity: "3" }], payments: { cash: "300" } });
    expect(preview.problems).toEqual([]);
    expect(saved).not.toBeNull();
    expect(await here(owner, places[0]!.id, id)).toBe(7);
    expect(await db.owner.select().from(godowns).where(eq(godowns.shopId, shop.shopId))).toHaveLength(1);
  });
});

describe("managing godowns", () => {
  it("lets only the owner add and rename, refuses duplicates, and never deletes or loses a godown's history", async () => {
    const { owner } = await newShop("Godown admin shop");
    const second = await createGodown(owner, { name: "Shop floor" });
    expect(await refusal(createGodown(owner, { name: "shop FLOOR" }))).toBe("You already have a godown with this name.");
    expect(translateServerMessage("You already have a godown with this name.", "hi")).toMatch(/[ऀ-ॿ]/);
    await renameGodown(owner, second.id, { name: "Showroom" });
    expect((await listGodowns(owner)).map((place) => place.name)).toEqual(["Main Store", "Showroom"]);
    for (const role of ["manager", "cashier", "inventory"] as const) {
      const session = await signInAs((await createTestShop(db, `Other ${role}`)).users[role]).then((result) => result.session);
      await expect(createGodown(session, { name: "Nope" })).rejects.toThrow();
    }
    await expect(db.ownerPool.query("delete from godowns")).rejects.toThrow();
    await expect(db.ownerPool.query("update godowns set shop_id = gen_random_uuid()")).rejects.toThrow();
  });

  it("turns a godown off only when it is empty, keeps its history, and never turns the Main Store off", async () => {
    const { owner } = await newShop("Godown off shop");
    const id = await pipe(owner);
    const second = await createGodown(owner, { name: "Yard" });
    const [main] = await listGodowns(owner);
    await stockIn(owner, second.id, id, "5");
    expect(await refusal(setGodownActive(owner, second.id, false))).toBe("This godown still has stock. Move it to another godown first.");
    expect(await refusal(setGodownActive(owner, main!.id, false))).toBe("The Main Store can't be turned off.");
    await transferStock(owner, { idempotencyKey: key(), fromGodownId: second.id, toGodownId: main!.id, lines: [{ productId: id, unit: "pc", quantity: "5" }] });
    await setGodownActive(owner, second.id, false);
    expect((await listGodowns(owner)).map((place) => place.name)).toEqual(["Main Store"]);
    expect((await listGodowns(owner, { includeInactive: true })).find((place) => place.id === second.id)?.isActive).toBe(false);
    // History still points at it, and it cannot be chosen for new stock.
    expect((await db.owner.select().from(stockMovements).where(eq(stockMovements.godownId, second.id))).length).toBeGreaterThan(0);
    expect(await refusal(stockIn(owner, second.id, id, "1"))).toBe("Choose one of your godowns.");
    await setGodownActive(owner, second.id, true);
    expect((await listGodowns(owner))).toHaveLength(2);
  });
});

describe("receipts, dispatch and reversals with several godowns", () => {
  it("receives into the Main Store unless a godown is chosen, and never takes goods from a godown that was not chosen", async () => {
    const { owner } = await newShop("Dispatch shop");
    const id = await pipe(owner);
    const floor = (await createGodown(owner, { name: "Shop floor" })).id;
    const [main] = await listGodowns(owner);
    await stockIn(owner, undefined, id, "10"); // no godown named: Main Store
    await stockIn(owner, floor, id, "4"); // chosen
    expect(await here(owner, main!.id, id)).toBe(10);
    expect(await here(owner, floor, id)).toBe(4);

    // Nothing chosen: the bill says so and cannot be saved, even though the Main Store has plenty.
    const none = await sell(owner, { lines: [{ productId: id, unit: "pc", quantity: "2" }], payments: { cash: "200" } });
    expect(none.preview.problems.map((problem) => problem.code)).toContain("GODOWN_REQUIRED");
    expect(none.saved).toBeNull();
    // The shop floor has only 4: 6 is refused there although the shop as a whole has 14.
    const short = await sell(owner, { godownId: floor, lines: [{ productId: id, unit: "pc", quantity: "6" }], payments: { cash: "600" } });
    expect(short.preview.problems.map((problem) => problem.code)).toContain("INSUFFICIENT_STOCK");
    expect(await total("", id)).toBe(14);
    // A valid choice takes stock only from that godown.
    const ok = await sell(owner, { godownId: floor, lines: [{ productId: id, unit: "pc", quantity: "3" }], payments: { cash: "300" } });
    expect(ok.saved).not.toBeNull();
    expect(await here(owner, floor, id)).toBe(1);
    expect(await here(owner, main!.id, id)).toBe(10);
    // Cancelling the bill puts the goods back where they came from.
    await cancelInvoice(owner, ok.saved!.id, { reason: "Wrong shop" });
    expect(await here(owner, floor, id)).toBe(4);
    expect(await here(owner, main!.id, id)).toBe(10);
  });

  it("puts returned goods and a cancelled receipt back into the godown they came from", async () => {
    const { owner } = await newShop("Reversal shop");
    const id = await pipe(owner);
    const floor = (await createGodown(owner, { name: "Shop floor" })).id;
    const [main] = await listGodowns(owner);
    await stockIn(owner, main!.id, id, "10");
    const receipt = await stockIn(owner, floor, id, "6");
    const sale = await sell(owner, { godownId: floor, lines: [{ productId: id, unit: "pc", quantity: "4" }], payments: { cash: "400" } });
    const [line] = (await getReturnableInvoice(owner, sale.saved!.id)).lines;
    const ret = { invoiceId: sale.saved!.id, lines: [{ invoiceLineId: line!.id, baseQty: "2", restock: true }], reason: "Extra", settlement: "cash" as const };
    await createReturn(owner, { ...ret, idempotencyKey: key(), expectedTotalPaise: (await previewReturn(owner, ret)).totalPaise });
    expect(await here(owner, floor, id)).toBe(4); // 6 - 4 + 2
    expect(await here(owner, main!.id, id)).toBe(10);
    // The receipt was brought into the shop floor, so only the shop floor's stock can cancel it.
    await transferStock(owner, { idempotencyKey: key(), fromGodownId: floor, toGodownId: main!.id, lines: [{ productId: id, unit: "pc", quantity: "4" }] });
    expect(await refusal(cancelGoodsReceipt(owner, receipt.id, { reason: "Wrong supplier" }))).toMatch(/left, less than this receipt/);
    await transferStock(owner, { idempotencyKey: key(), fromGodownId: main!.id, toGodownId: floor, lines: [{ productId: id, unit: "pc", quantity: "6" }] });
    await cancelGoodsReceipt(owner, receipt.id, { reason: "Wrong supplier" });
    // The shop floor is empty again; the Main Store keeps its 10, plus the 4 moved in from the floor, less the 6 moved back out.
    expect(await here(owner, floor, id)).toBe(0);
    expect(await here(owner, main!.id, id)).toBe(8);
    expect(await total("", id)).toBe(8);
  });

  it("asks for a godown on an adjustment once there are several, counts each godown on its own, and keeps the entered quantity and unit", async () => {
    const { owner } = await newShop("Adjustment shop");
    const id = await pipe(owner);
    const floor = (await createGodown(owner, { name: "Shop floor" })).id;
    const [main] = await listGodowns(owner);
    await stockIn(owner, main!.id, id, "30");
    const base = { idempotencyKey: key(), productId: id, kind: "damage", unit: "box", quantity: "1", reason: "Broken in storage" };
    expect(await refusal(recordAdjustment(owner, base))).toBe("Choose which godown the stock comes from.");
    expect(await refusal(recordAdjustment(owner, { ...base, idempotencyKey: key(), godownId: floor }))).toMatch(/Stock can't go below zero/);
    await recordAdjustment(owner, { ...base, idempotencyKey: key(), godownId: main!.id });
    expect(await here(owner, main!.id, id)).toBe(18);
    const [movement] = await db.owner.select().from(stockMovements).where(eq(stockMovements.kind, "damage"));
    expect(movement).toMatchObject({ enteredQty: "1.000", enteredUnit: "box", enteredFactor: "12.000", godownId: main!.id });
  });

  it("opens each godown once per product, and refuses a second opening in the same godown", async () => {
    const { owner } = await newShop("Opening shop");
    const id = await pipe(owner);
    const floor = (await createGodown(owner, { name: "Shop floor" })).id;
    await recordOpeningStock(owner, { idempotencyKey: key(), movementDate: today, lines: [{ productId: id, unit: "pc", quantity: "5" }] });
    await recordOpeningStock(owner, { idempotencyKey: key(), movementDate: today, godownId: floor, lines: [{ productId: id, unit: "box", quantity: "2" }] });
    expect(await here(owner, floor, id)).toBe(24);
    expect(await refusal(recordOpeningStock(owner, { idempotencyKey: key(), movementDate: today, godownId: floor, lines: [{ productId: id, unit: "pc", quantity: "1" }] }))).toMatch(/needs? attention/);
    expect(await total("", id)).toBe(29);
  });
});

describe("transfers", () => {
  it("moves stock in one atomic step, keeps the total, posts no journal and changes no profit or stock value", async () => {
    const { shop, owner } = await newShop("Transfer shop");
    await activateBusinessAccounts(owner, { coverageStartDate: addDays(today, -10) });
    const id = await pipe(owner);
    const floor = (await createGodown(owner, { name: "Shop floor" })).id;
    const [main] = await listGodowns(owner);
    await stockIn(owner, main!.id, id, "30");
    const journalsBefore = (await db.owner.select().from(journals).where(eq(journals.shopId, shop.shopId))).length;
    const booksBefore = (await accountBalances(owner)).map((row) => [row.systemKey, row.debitPaise, row.creditPaise]);
    const movementsBefore = (await db.owner.select().from(stockMovements)).length;

    const request = { idempotencyKey: key(), fromGodownId: main!.id, toGodownId: floor, reason: "Fill the shop", lines: [{ productId: id, unit: "box", quantity: "2" }] };
    const first = await transferStock(owner, request);
    expect(first).toMatchObject({ replayed: false });
    expect(first.number).toMatch(/^TRF\//);
    expect(await here(owner, main!.id, id)).toBe(6);
    expect(await here(owner, floor, id)).toBe(24);
    expect(await total("", id)).toBe(30);

    // Two distinct, identifiable legs sharing one source; the entered box quantity is kept.
    const legs = (await db.owner.select().from(stockMovements).where(eq(stockMovements.sourceId, first.id))).sort((a, b) => a.id - b.id);
    expect(legs.map((leg) => [leg.kind, leg.godownId, Number(leg.qtyBase)])).toEqual([["transfer_out", main!.id, -24], ["transfer_in", floor, 24]]);
    expect(legs[0]).toMatchObject({ enteredQty: "2.000", enteredUnit: "box", enteredFactor: "12.000" });
    expect(legs[0]!.unitCostPaise).toBe(legs[1]!.unitCostPaise);

    // No journal, no change to any account, and exactly the two new movements.
    expect((await db.owner.select().from(journals).where(eq(journals.shopId, shop.shopId))).length).toBe(journalsBefore);
    expect((await accountBalances(owner)).map((row) => [row.systemKey, row.debitPaise, row.creditPaise])).toEqual(booksBefore);
    expect((await db.owner.select().from(stockMovements)).length).toBe(movementsBefore + 2);

    // The same request again is the same transfer.
    const again = await transferStock(owner, request);
    expect(again).toMatchObject({ id: first.id, replayed: true });
    expect((await db.owner.select().from(stockMovements)).length).toBe(movementsBefore + 2);
    expect((await listTransfers(owner)).map((transfer) => transfer.number)).toEqual([first.number]);
  });

  it("writes nothing when any line fails, refuses what the source godown cannot cover, and never goes negative under a race", async () => {
    const { owner } = await newShop("Transfer rules shop");
    const a = await pipe(owner);
    const b = await pipe(owner);
    const floor = (await createGodown(owner, { name: "Shop floor" })).id;
    const [main] = await listGodowns(owner);
    await stockIn(owner, main!.id, a, "10");
    await stockIn(owner, main!.id, b, "2");
    const before = (await db.owner.select().from(stockMovements)).length;
    const move = (lines: { productId: string; unit: string; quantity: string }[], to = floor) => transferStock(owner, { idempotencyKey: key(), fromGodownId: main!.id, toGodownId: to, lines });
    // Second line is short: the first must not be moved either, and the number is given back.
    expect(await refusal(move([{ productId: a, unit: "pc", quantity: "5" }, { productId: b, unit: "pc", quantity: "3" }]))).toMatch(/Only 2 pc of Pipe \d+ in Main Store, less than 3/);
    expect((await db.owner.select().from(stockMovements)).length).toBe(before);
    expect(await refusal(move([{ productId: a, unit: "pc", quantity: "1" }], main!.id))).toBe("Choose a different godown to move the stock to.");
    expect(await refusal(move([{ productId: a, unit: "pc", quantity: "1" }, { productId: a, unit: "pc", quantity: "1" }]))).toMatch(/already on line 1/);
    expect(await refusal(move([{ productId: a, unit: "pc", quantity: "0" }]))).toBe("Enter a quantity above zero.");
    expect(await refusal(move([{ productId: a, unit: "pallet", quantity: "1" }]))).toMatch(/isn't sold in "pallet"/);
    const ok = await move([{ productId: a, unit: "pc", quantity: "4" }]);
    expect(ok.number).toBe((await listTransfers(owner))[0]!.number);

    // Two transfers of 6 from the 6 left: exactly one wins, and stock is never below zero anywhere.
    const results = await Promise.allSettled([move([{ productId: a, unit: "pc", quantity: "6" }]), move([{ productId: a, unit: "pc", quantity: "6" }])]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await here(owner, main!.id, a)).toBe(0);
    expect(await here(owner, floor, a)).toBe(10);
    expect((await db.owner.select().from(stockLevels).where(sql`${stockLevels.qtyBase} < 0`))).toHaveLength(0);
  });

  it("is for staff who may adjust stock, stays inside one shop, and keeps another shop's godowns out", async () => {
    const mine = await newShop("Transfer owner shop");
    const theirs = await newShop("Transfer other shop");
    const id = await pipe(mine.owner);
    const floor = (await createGodown(mine.owner, { name: "Shop floor" })).id;
    const [main] = await listGodowns(mine.owner);
    await stockIn(mine.owner, main!.id, id, "5");
    const foreign = (await listGodowns(theirs.owner))[0]!.id;
    const request = (to: string) => ({ idempotencyKey: key(), fromGodownId: main!.id, toGodownId: to, lines: [{ productId: id, unit: "pc", quantity: "1" }] });
    expect(await refusal(transferStock(mine.owner, request(foreign)))).toBe("Choose a godown to move the stock to.");
    await expect(transferStock(await as(mine.shop, "cashier"), request(floor))).rejects.toThrow();
    await transferStock(await as(mine.shop, "inventory"), request(floor));
    expect(await listTransfers(theirs.owner)).toEqual([]);
    expect(await godownStock(theirs.owner)).toEqual([]);
  });
});

describe("reconciliation per godown", () => {
  it("flags a godown whose stored total is wrong even when the shop total still adds up, and rebuilds each godown from its own entries", async () => {
    const { owner } = await newShop("Reconcile shop");
    const id = await pipe(owner);
    const floor = (await createGodown(owner, { name: "Shop floor" })).id;
    const [main] = await listGodowns(owner);
    await stockIn(owner, main!.id, id, "10");
    await stockIn(owner, floor, id, "10");
    expect((await listStock(owner)).items.find((row) => row.productId === id)?.status).not.toBe("needs_check");
    // One godown's cache is 3 too high and the other 3 too low: the total still agrees with the journal.
    await db.owner.execute(sql`update stock_levels set qty_base = qty_base + 3 where product_id = ${id} and godown_id = ${main!.id}`);
    await db.owner.execute(sql`update stock_levels set qty_base = qty_base - 3 where product_id = ${id} and godown_id = ${floor}`);
    const flagged = (await listStock(owner)).items.find((row) => row.productId === id);
    expect(flagged?.status).toBe("needs_check");
    expect(flagged?.qty).toBe("20");
    await rebuildStockCache(owner, id);
    expect((await listStock(owner)).items.find((row) => row.productId === id)?.status).not.toBe("needs_check");
    const levels = await db.owner.select().from(stockLevels).where(eq(stockLevels.productId, id));
    expect(levels.map((level) => Number(level.qtyBase)).sort()).toEqual([10, 10]);
    // The godown filter shows one godown's own stock.
    expect((await listStock(owner, { godownId: floor })).items.find((row) => row.productId === id)?.qty).toBe("10");
  });
});
