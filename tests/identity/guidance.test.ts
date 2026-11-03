import { and, eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/errors";
import { recordAudit } from "@/modules/audit";
import {
  confirmGuidedTaskSaved,
  finishedTips,
  finishTip,
  isGuidedTaskSaved,
  loadPermissions,
  pauseGuidedTask,
  setGuidedTaskStep,
  setUserLanguage,
  skipGuidedTask,
  startGuidedTask,
  taskProgress,
} from "@/modules/identity";
import { userGuidance } from "@/modules/identity/schema";
import { createCustomer } from "@/modules/parties";
import { withTransaction } from "@/server/db";
import { GUIDE_MODULES, GUIDED_TASK_KEYS, GUIDED_TASKS, saveStepIndex, tasksFor } from "@/shared/guidance";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
let shop: TestShop;
let other: TestShop;

beforeAll(async () => {
  shop = await createTestShop(db);
  other = await createTestShop(db, "Other Shop");
});

const session = async (role: keyof TestShop["users"], from = shop) => (await signInAs(from.users[role])).session;
const progress = async (who: Awaited<ReturnType<typeof session>>, key: (typeof GUIDED_TASK_KEYS)[number]) => (await taskProgress(who)).find((row) => row.key === key);

describe("first-time tips", () => {
  beforeEach(async () => {
    await db.owner.execute(sql`delete from user_guidance`);
  });

  it("a first visit has nothing finished; a finished tip stays finished after signing in again", async () => {
    const owner = await session("owner");
    expect((await finishedTips(owner)).has("customers")).toBe(false);
    await finishTip(owner, "customers", "done");
    expect((await finishedTips(await session("owner"))).has("customers")).toBe(true);
  });

  it("modules are separate, and dismissing counts the same as Got it", async () => {
    const manager = await session("manager");
    await finishTip(manager, "billing", "dismissed");
    const finished = await finishedTips(manager);
    expect(finished.has("billing")).toBe(true);
    expect(finished.has("purchases")).toBe(false);
  });

  it("each role keeps its own progress, and shops never mix", async () => {
    await finishTip(await session("owner"), "settings", "done");
    for (const role of ["manager", "cashier", "inventory"] as const) expect((await finishedTips(await session(role))).has("settings")).toBe(false);
    expect((await finishedTips(await session("owner", other))).has("settings")).toBe(false);
  });

  it("changing language keeps progress", async () => {
    const cashier = await session("cashier");
    await finishTip(cashier, "notifications", "done");
    await setUserLanguage(cashier, "hi");
    expect((await finishedTips(cashier)).has("notifications")).toBe(true);
    await setUserLanguage(cashier, "en");
  });

  it("repeating an answer changes nothing, and an unknown module is refused", async () => {
    const owner = await session("owner");
    await finishTip(owner, "reports", "done");
    await finishTip(owner, "reports", "dismissed");
    const rows = await db.owner.select().from(userGuidance).where(and(eq(userGuidance.userId, owner.userId), eq(userGuidance.key, "reports")));
    expect(rows.map((row) => row.status)).toEqual(["done"]);
    await expect(finishTip(owner, "nonsense", "done")).rejects.toThrow();
  });

  it("a module's permission decides who could see its tip", async () => {
    const allowed = async (role: keyof TestShop["users"], module: keyof typeof GUIDE_MODULES) => {
      const permission = GUIDE_MODULES[module].permission;
      return permission === null || (await loadPermissions(await session(role))).has(permission);
    };
    expect(await allowed("cashier", "dashboard")).toBe(false);
    expect(await allowed("cashier", "purchases")).toBe(false);
    expect(await allowed("inventory", "billing")).toBe(false);
    expect(await allowed("inventory", "cashbook")).toBe(false);
    expect(await allowed("manager", "pricing")).toBe(false);
    expect(await allowed("owner", "pricing")).toBe(true);
    expect(await allowed("inventory", "settings")).toBe(true);
  });
});

describe("guided tasks", () => {
  beforeEach(async () => {
    await db.owner.execute(sql`delete from user_guidance`);
  });

  it("offers each role only the tasks it may do", async () => {
    const offered = async (role: keyof TestShop["users"]) => tasksFor(await loadPermissions(await session(role)));
    expect(await offered("owner")).toEqual(GUIDED_TASK_KEYS);
    expect(await offered("manager")).toEqual(GUIDED_TASK_KEYS);
    expect(await offered("cashier")).toEqual(["createSale", "receivePayment"]);
    expect(await offered("inventory")).toEqual(["recordPurchase", "updateStock"]);
  });

  it("the server refuses a task the role may not do", async () => {
    await expect(startGuidedTask(await session("cashier"), "addCustomer")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(startGuidedTask(await session("inventory"), "createSale")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("every task has one save step, followed by a confirmation", () => {
    for (const key of GUIDED_TASK_KEYS) {
      const { steps } = GUIDED_TASKS[key];
      expect(steps.filter((step) => step.done.kind === "saved")).toHaveLength(1);
      expect(saveStepIndex(key)).toBe(steps.length - 2);
      expect(steps.at(-1)!.done.kind).toBe("result");
    }
  });

  it("moves Previous and Next, resumes after Exit and after signing in again", async () => {
    const owner = await session("owner");
    await startGuidedTask(owner, "createSale");
    await setGuidedTaskStep(owner, "createSale", 3);
    await setGuidedTaskStep(owner, "createSale", 2);
    await pauseGuidedTask(owner, "createSale");
    expect((await progress(owner, "createSale"))).toMatchObject({ status: "paused", step: 2 });
    const again = await session("owner");
    expect((await startGuidedTask(again, "createSale")).step).toBe(2);
    expect((await progress(again, "createSale"))?.status).toBe("in_progress");
  });

  it("Next can't jump past the save step", async () => {
    const owner = await session("owner");
    await startGuidedTask(owner, "addCustomer");
    await expect(setGuidedTaskStep(owner, "addCustomer", saveStepIndex("addCustomer") + 1)).rejects.toThrow();
    expect((await progress(owner, "addCustomer"))?.status).toBe("in_progress");
  });

  it("completes only after the real workflow saves, and doesn't count an earlier save", async () => {
    const owner = await session("owner");
    await createCustomer(owner, { name: "Before The Guide", phone: "9123400001", type: "retail", creditLimit: "0" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await startGuidedTask(owner, "addCustomer");
    expect(await isGuidedTaskSaved(owner, "addCustomer")).toBe(false);
    expect(await confirmGuidedTaskSaved(owner, "addCustomer")).toBeNull();
    expect((await progress(owner, "addCustomer"))?.status).toBe("in_progress");

    await createCustomer(owner, { name: "From The Guide", phone: "9123400002", type: "retail", creditLimit: "0" });
    const last = GUIDED_TASKS.addCustomer.steps.length - 1;
    expect(await confirmGuidedTaskSaved(owner, "addCustomer")).toBe(last);
    expect(await progress(owner, "addCustomer")).toMatchObject({ status: "completed", step: last, everCompleted: true });
    expect(await progress(owner, "createSale")).toBeUndefined();
  });

  it.each([
    ["createSale", "sales.invoice_issued"],
    ["recordPurchase", "purchasing.goods_received"],
    ["receivePayment", "payments.receipt_recorded"],
    ["updateStock", "inventory.adjustment_recorded"],
  ] as const)("%s completes on its workflow's own audit action, not another's", async (key, action) => {
    expect(GUIDED_TASKS[key].auditAction).toBe(action);
    const manager = await session("manager");
    await startGuidedTask(manager, key);
    const write = (name: string) => withTransaction((tx) => recordAudit(tx, { shopId: manager.shopId, userId: manager.userId, role: manager.role }, { action: name, entityType: "test", entityId: name }));
    await write("parties.customer_added");
    expect(await isGuidedTaskSaved(manager, key)).toBe(false);
    await write(action);
    expect(await confirmGuidedTaskSaved(manager, key)).toBe(GUIDED_TASKS[key].steps.length - 1);
  });

  it("another person's save doesn't complete my task", async () => {
    const owner = await session("owner");
    await startGuidedTask(owner, "addCustomer");
    await createCustomer(await session("manager"), { name: "Manager Adds", phone: "9123400003", type: "retail", creditLimit: "0" });
    expect(await isGuidedTaskSaved(owner, "addCustomer")).toBe(false);
  });

  it("people have independent progress; language changes keep it; replay starts again", async () => {
    const owner = await session("owner");
    const manager = await session("manager");
    await startGuidedTask(owner, "updateStock");
    await setGuidedTaskStep(owner, "updateStock", 4);
    expect(await progress(manager, "updateStock")).toBeUndefined();
    await setUserLanguage(owner, "hinglish");
    expect((await progress(owner, "updateStock"))?.step).toBe(4);
    await setUserLanguage(owner, "en");
    expect((await startGuidedTask(owner, "updateStock", { restart: true })).step).toBe(0);
  });

  it("a replay needs a new save: the save that finished the last run doesn't count", async () => {
    const owner = await session("owner");
    await startGuidedTask(owner, "addCustomer");
    await createCustomer(owner, { name: "First Run", phone: "9123400011", type: "retail", creditLimit: "0" });
    expect(await confirmGuidedTaskSaved(owner, "addCustomer")).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await startGuidedTask(owner, "addCustomer", { restart: true });
    expect(await progress(owner, "addCustomer")).toMatchObject({ status: "in_progress", step: 0, everCompleted: true });
    expect(await isGuidedTaskSaved(owner, "addCustomer")).toBe(false);
    expect(await confirmGuidedTaskSaved(owner, "addCustomer")).toBeNull();
  });

  it("confirming twice writes no second record, and a save in another shop doesn't count", async () => {
    const owner = await session("owner");
    const count = async () => Number(((await db.owner.execute(sql`select (select count(*) from audit_log) + (select count(*) from customers) as n`)).rows[0] as { n: string }).n);
    await startGuidedTask(owner, "addCustomer");
    await createCustomer(await session("owner", other), { name: "Other Shop Save", phone: "9123400012", type: "retail", creditLimit: "0" });
    expect(await isGuidedTaskSaved(owner, "addCustomer")).toBe(false);
    await createCustomer(owner, { name: "My Save", phone: "9123400013", type: "retail", creditLimit: "0" });
    const before = await count();
    await confirmGuidedTaskSaved(owner, "addCustomer");
    await confirmGuidedTaskSaved(owner, "addCustomer");
    expect(await count()).toBe(before);
    const rows = await db.owner.select().from(userGuidance).where(and(eq(userGuidance.userId, owner.userId), eq(userGuidance.key, "addCustomer")));
    expect(rows).toHaveLength(1);
  });

  it("only one task runs at a time", async () => {
    const owner = await session("owner");
    await startGuidedTask(owner, "addCustomer");
    await startGuidedTask(owner, "createSale");
    expect((await progress(owner, "addCustomer"))?.status).toBe("paused");
    expect((await progress(owner, "createSale"))?.status).toBe("in_progress");
  });

  it("Skip, Exit and walking the steps create no business records or audit rows", async () => {
    const owner = await session("owner");
    const count = async () => Number(((await db.owner.execute(sql`select (select count(*) from audit_log) + (select count(*) from customers) + (select count(*) from invoices) + (select count(*) from payments) + (select count(*) from goods_receipts) + (select count(*) from stock_movements) as n`)).rows[0] as { n: string }).n);
    const before = await count();
    for (const key of GUIDED_TASK_KEYS) {
      await startGuidedTask(owner, key);
      await setGuidedTaskStep(owner, key, saveStepIndex(key));
      await pauseGuidedTask(owner, key);
      await startGuidedTask(owner, key);
      await skipGuidedTask(owner, key);
      expect((await progress(owner, key))?.status).toBe("skipped");
    }
    expect(await count()).toBe(before);
  });

  it("stores only task and step: no column can hold form contents", async () => {
    const columns = (await db.owner.execute(sql`select column_name from information_schema.columns where table_name = 'user_guidance'`)).rows.map((row) => (row as { column_name: string }).column_name).sort();
    expect(columns).toEqual(["completed_at", "created_at", "key", "kind", "shop_id", "started_at", "status", "step", "updated_at", "user_id"]);
  });
});
