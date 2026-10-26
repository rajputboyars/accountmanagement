import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { auditLog } from "@/modules/audit/schema";
import { createProduct } from "@/modules/catalog";
import {
  consumeApproval,
  countPendingApprovals,
  decideApproval,
  hasPermission,
  listApprovals,
  requestApproval,
  revokeStaffAccess,
  setOwnerPin,
  setStaffActive,
  updateStaffRole,
  validateSessionToken,
} from "@/modules/identity";
import { approvals, users } from "@/modules/identity/schema";
import { getProductStock, recordAdjustment, recordOpeningStock } from "@/modules/inventory";
import { stockAdjustments } from "@/modules/inventory/schema";
import { partyBalance } from "@/modules/ledger";
import { createCustomer } from "@/modules/parties";
import { correctInvoice, createInvoice, previewBill, type BillInput } from "@/modules/sales";
import { invoices } from "@/modules/sales/schema";
import { withTransaction } from "@/server/db";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { indiaDate } from "@/shared/financial-year";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
let shopA: TestShop;
let shopB: TestShop;

const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const today = indiaDate();
const OWNER_PIN = "2580";

beforeAll(async () => {
  shopA = await createTestShop(db, "Shop A");
  shopB = await createTestShop(db, "Shop B");
  const ownerA = await signInAs(shopA.users.owner);
  await setOwnerPin(ownerA.session, OWNER_PIN);
});

describe("staff controls (role assignment and session revocation)", () => {
  it("enforces that only the owner can update roles and revoke access", async () => {
    const cashier = await signInAs(shopA.users.cashier);
    const manager = await signInAs(shopA.users.manager);
    await expect(updateStaffRole(cashier.session, shopA.users.inventory.id, "manager")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(revokeStaffAccess(cashier.session, shopA.users.inventory.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateStaffRole(manager.session, shopA.users.cashier.id, "inventory")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(revokeStaffAccess(manager.session, shopA.users.cashier.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("prevents the owner from changing their own role or revoking their own access", async () => {
    const owner = await signInAs(shopA.users.owner);
    await expect(updateStaffRole(owner.session, owner.session.userId, "manager")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(revokeStaffAccess(owner.session, owner.session.userId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("updates a role, signs the person out everywhere and audits the change", async () => {
    const owner = await signInAs(shopA.users.owner);
    const cashierSignIn = await signInAs(shopA.users.cashier);
    expect(await validateSessionToken(cashierSignIn.token)).not.toBeNull();
    const updated = await updateStaffRole(owner.session, shopA.users.cashier.id, "manager");
    expect(updated.role).toBe("manager");
    expect(await validateSessionToken(cashierSignIn.token)).toBeNull();
    const [audit] = await db.owner.select().from(auditLog).where(and(eq(auditLog.entityId, shopA.users.cashier.id), eq(auditLog.action, "identity.staff_role_updated")));
    expect(audit).toMatchObject({ before: { role: "cashier" }, after: { role: "manager" }, userId: owner.session.userId });
    await updateStaffRole(owner.session, shopA.users.cashier.id, "cashier");
    await expect(updateStaffRole(owner.session, shopB.users.cashier.id, "manager")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("signs a staff member out without switching the account off", async () => {
    const owner = await signInAs(shopA.users.owner);
    const inventorySignIn = await signInAs(shopA.users.inventory);
    const result = await revokeStaffAccess(owner.session, shopA.users.inventory.id);
    expect(result.revokedSessions).toBeGreaterThanOrEqual(1);
    expect(await validateSessionToken(inventorySignIn.token)).toBeNull();
    const [user] = await db.owner.select({ isActive: users.isActive }).from(users).where(eq(users.id, shopA.users.inventory.id));
    expect(user!.isActive).toBe(true);
    const [audit] = await db.owner.select().from(auditLog).where(and(eq(auditLog.entityId, shopA.users.inventory.id), eq(auditLog.action, "identity.staff_access_revoked")));
    expect(audit).toBeDefined();
  });

  it("switching a staff member off signs them out", async () => {
    const owner = await signInAs(shopA.users.owner);
    const inventory = await signInAs(shopA.users.inventory);
    await setStaffActive(owner.session, shopA.users.inventory.id, false);
    expect(await validateSessionToken(inventory.token)).toBeNull();
    await setStaffActive(owner.session, shopA.users.inventory.id, true);
  });
});

// ── Approvals ────────────────────────────────────────────────────────────────

type Session = Awaited<ReturnType<typeof signInAs>>["session"];
let n = 0;

/** A product at ₹100 a piece, cost ₹50, no GST, with 500 in stock. */
async function product(owner: Session) {
  n += 1;
  const { id } = await createProduct(owner, { name: `Valve ${n}`, sku: `AP-${n}-${randomUUID().slice(0, 4)}`, baseUnit: "pc", hsn: "8481", gstRateBp: "0", retailPaise: "100", wholesalePaise: "90", costPaise: "50" });
  await recordOpeningStock(owner, { idempotencyKey: key(), movementDate: today, lines: [{ productId: id, unit: "pc", quantity: "500" }] });
  return id;
}

const adjust = (session: Session, productId: string, quantity: string, extra: Record<string, string> = {}) => recordAdjustment(session, { idempotencyKey: key(), productId, kind: "damage", unit: "pc", quantity, reason: "Broken in storage", ...extra });
const askStock = (session: Session, productId: string, rupees: number) => requestApproval(session, { action: "stock_adjustment", targetRef: productId, targetLabel: "Valve", reason: "Rack fell", amountPaise: rupees * 100 });
const owner = async () => (await signInAs(shopA.users.owner)).session;
const as = async (role: "manager" | "cashier" | "inventory") => (await signInAs(shopA.users[role])).session;
const approve = async (id: string) => decideApproval(await owner(), { approvalId: id, decision: "approve" });

async function sell(session: Session, input: BillInput) {
  const preview = await previewBill(session, input);
  return createInvoice(session, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates });
}

describe("approval requests and decisions", () => {
  it("only the owner decides; every role can see its own requests", async () => {
    for (const role of ["manager", "cashier", "inventory"] as const) {
      const session = await as(role);
      expect(await hasPermission(session, "approvals.view")).toBe(true);
      expect(await hasPermission(session, "approvals.decide")).toBe(false);
    }
    expect(await hasPermission(await owner(), "approvals.decide")).toBe(true);
  });

  it("records a structured request with a 10-minute expiry, audits it and refuses what the asker can't do", async () => {
    const inventory = await as("inventory");
    const cashier = await as("cashier");
    const productId = await product(await owner());
    const request = await askStock(inventory, productId, 3000);
    expect(request).toMatchObject({ status: "pending", targetType: "product", targetRef: productId, amountPaise: 300000, duplicate: false, notification: { delivered: false, channel: "in_app" } });
    const minutes = (request.expiresAt.getTime() - request.createdAt.getTime()) / 60_000;
    expect(minutes).toBeGreaterThan(9.9);
    expect(minutes).toBeLessThan(10.1);
    const [audit] = await db.owner.select().from(auditLog).where(and(eq(auditLog.entityId, request.id), eq(auditLog.action, "identity.approval_requested")));
    expect(audit).toMatchObject({ userId: inventory.userId, reason: "Rack fell" });
    // A cashier can't adjust stock, so can't ask to; the owner never needs to ask; a discount needs its %.
    await expect(askStock(cashier, productId, 3000)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(askStock(await owner(), productId, 3000)).rejects.toMatchObject({ code: "OWNER_NO_APPROVAL" });
    await expect(requestApproval(cashier, { action: "discount_over_limit", targetRef: "any", targetLabel: "Any", reason: "Festival" })).rejects.toThrow("Enter the discount % you need.");
    expect(await countPendingApprovals(await owner())).toBeGreaterThan(0);
  });

  it("returns the same pending request instead of a duplicate, even when sent twice at once", async () => {
    const inventory = await as("inventory");
    const productId = await product(await owner());
    const [a, b] = await Promise.all([askStock(inventory, productId, 3000), askStock(inventory, productId, 3000)]);
    expect(a.id).toBe(b.id);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    expect(await db.owner.select().from(approvals).where(eq(approvals.targetRef, productId))).toHaveLength(1);
  });

  it("never lets someone decide their own request", async () => {
    const manager = await as("manager");
    const productId = await product(await owner());
    const request = await askStock(manager, productId, 3000);
    await expect(decideApproval(manager, { approvalId: request.id, decision: "approve" })).rejects.toBeInstanceOf(ForbiddenError);
    // Even if the shop gave managers the decide permission, their own request stays off limits.
    await db.owner.execute(sql`update role_permissions set allowed = true where shop_id = ${shopA.shopId} and role = 'manager' and permission = 'approvals.decide'`);
    try {
      await expect(decideApproval(manager, { approvalId: request.id, decision: "approve" })).rejects.toThrow("You can't decide your own request.");
    } finally {
      await db.owner.execute(sql`update role_permissions set allowed = false where shop_id = ${shopA.shopId} and role = 'manager' and permission = 'approvals.decide'`);
    }
  });

  it("needs a reason to reject; a rejected request can never be used or decided again", async () => {
    const boss = await owner();
    const inventory = await as("inventory");
    const productId = await product(boss);
    const request = await askStock(inventory, productId, 3000);
    await expect(decideApproval(boss, { approvalId: request.id, decision: "reject" })).rejects.toBeInstanceOf(ValidationError);
    expect(await decideApproval(boss, { approvalId: request.id, decision: "reject", reason: "Count it again first" })).toMatchObject({ status: "rejected", decisionReason: "Count it again first" });
    await expect(decideApproval(boss, { approvalId: request.id, decision: "approve" })).rejects.toMatchObject({ code: "ALREADY_DECIDED" });
    await expect(adjust(inventory, productId, "50")).rejects.toMatchObject({ code: "OWNER_APPROVAL_REQUIRED" });
    await expect(adjust(inventory, productId, "50", { approvalId: request.id })).rejects.toMatchObject({ code: "APPROVAL_REJECTED" });
    const [audit] = await db.owner.select().from(auditLog).where(and(eq(auditLog.entityId, request.id), eq(auditLog.action, "identity.approval_rejected")));
    expect(audit).toMatchObject({ userId: boss.userId, reason: "Count it again first" });
  });

  it("expired requests can't be approved or used", async () => {
    const inventory = await as("inventory");
    const productId = await product(await owner());
    const pending = await askStock(inventory, productId, 3000);
    await db.owner.update(approvals).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(approvals.id, pending.id));
    await expect(approve(pending.id)).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
    const fresh = await askStock(inventory, productId, 3000);
    expect(fresh.id).not.toBe(pending.id);
    await approve(fresh.id);
    await db.owner.update(approvals).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(approvals.id, fresh.id));
    await expect(adjust(inventory, productId, "50")).rejects.toMatchObject({ code: "OWNER_APPROVAL_REQUIRED" });
    expect((await listApprovals(await owner())).find((item) => item.id === fresh.id)?.status).toBe("expired");
  });

  it("keeps shops apart", async () => {
    const productId = await product(await owner());
    const request = await askStock(await as("inventory"), productId, 3000);
    const ownerB = (await signInAs(shopB.users.owner)).session;
    await expect(decideApproval(ownerB, { approvalId: request.id, decision: "approve" })).rejects.toBeInstanceOf(NotFoundError);
    expect((await listApprovals(ownerB)).map((item) => item.id)).not.toContain(request.id);
    const cashierRows = await listApprovals(await as("cashier"));
    expect(cashierRows.every((row) => row.requestedBy === shopA.users.cashier.id)).toBe(true);
  });
});

describe("approved actions run once, within what was approved", () => {
  it("a large stock adjustment uses the requester's approval once; a second one is refused", async () => {
    const boss = await owner();
    const inventory = await as("inventory");
    const productId = await product(boss);
    await expect(adjust(inventory, productId, "50")).rejects.toMatchObject({ code: "OWNER_APPROVAL_REQUIRED" }); // ₹2,500 at cost
    const request = await askStock(inventory, productId, 2500);
    await approve(request.id);
    const done = await adjust(inventory, productId, "50");
    const [row] = await db.owner.select().from(stockAdjustments).where(eq(stockAdjustments.id, done.id));
    expect(row!.approvalId).toBe(request.id);
    expect(Number((await getProductStock(boss, productId)).qty)).toBe(450);
    await expect(adjust(inventory, productId, "50")).rejects.toMatchObject({ code: "OWNER_APPROVAL_REQUIRED" });
    const [used] = await db.owner.select().from(auditLog).where(and(eq(auditLog.entityId, request.id), eq(auditLog.action, "identity.approval_used")));
    expect(used).toMatchObject({ userId: inventory.userId });
    expect((await listApprovals(boss)).find((item) => item.id === request.id)?.status).toBe("used");
  });

  it("refuses more than the approved value, another product, or another person's approval", async () => {
    const boss = await owner();
    const inventory = await as("inventory");
    const manager = await as("manager");
    const productId = await product(boss);
    const other = await product(boss);
    const request = await askStock(inventory, productId, 2500);
    await approve(request.id);
    await expect(adjust(inventory, productId, "60")).rejects.toMatchObject({ code: "OWNER_APPROVAL_REQUIRED" }); // ₹3,000 > ₹2,500
    await expect(adjust(inventory, other, "50")).rejects.toMatchObject({ code: "OWNER_APPROVAL_REQUIRED" });
    await expect(adjust(manager, productId, "50")).rejects.toMatchObject({ code: "OWNER_APPROVAL_REQUIRED" });
    await expect(adjust(manager, productId, "50", { approvalId: request.id })).rejects.toBeInstanceOf(ForbiddenError);
    await adjust(inventory, productId, "50"); // still unused, so the right person, product and value go through
  });

  it("two saves racing for one approval: exactly one wins", async () => {
    const boss = await owner();
    const inventory = await as("inventory");
    const productId = await product(boss);
    await approve((await askStock(inventory, productId, 2500)).id);
    const results = await Promise.allSettled([adjust(inventory, productId, "50"), adjust(inventory, productId, "50")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "OWNER_APPROVAL_REQUIRED" } });
    expect(Number((await getProductStock(boss, productId)).qty)).toBe(450);
  });

  it("an approval used in a transaction that rolls back stays unused", async () => {
    const inventory = await as("inventory");
    const productId = await product(await owner());
    const request = await askStock(inventory, productId, 2500);
    await approve(request.id);
    await expect(
      withTransaction(async (tx) => {
        await consumeApproval(tx, inventory, request.id, "stock_adjustment", [productId]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const [row] = await db.owner.select().from(approvals).where(eq(approvals.id, request.id));
    expect(row!.usedAt).toBeNull();
    await adjust(inventory, productId, "50");
  });

  it("the owner PIN still works on the spot", async () => {
    const boss = await owner();
    const productId = await product(boss);
    await adjust(await as("inventory"), productId, "50", { ownerPin: OWNER_PIN });
    expect(Number((await getProductStock(boss, productId)).qty)).toBe(450);
  });

  it("a cashier's discount above 3% goes through only up to the approved %, once", async () => {
    const boss = await owner();
    const cashier = await as("cashier");
    const productId = await product(boss);
    const pay = async (discountPercent: string) => {
      const input = { lines: [{ productId, unit: "pc", quantity: "10" }], discountPercent } as unknown as BillInput;
      const preview = await previewBill(boss, input);
      const rupees = String(preview.totals.totalPaise / 100);
      return createInvoice(cashier, { ...input, payments: { cash: rupees }, cashReceived: rupees, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates });
    };
    await expect(pay("10")).rejects.toMatchObject({ code: "DISCOUNT_APPROVAL_REQUIRED" });
    const request = await requestApproval(cashier, { action: "discount_over_limit", targetRef: "any", targetLabel: "Any customer", reason: "Bulk buyer", limitBp: 1000 });
    await approve(request.id);
    await expect(pay("12")).rejects.toMatchObject({ code: "DISCOUNT_APPROVAL_REQUIRED" });
    const invoice = await pay("10");
    const [row] = await db.owner.select().from(invoices).where(eq(invoices.id, invoice.id));
    expect(row).toMatchObject({ discountBp: 1000, discountApprovalId: request.id, totalPaise: 90000 });
    await expect(pay("10")).rejects.toMatchObject({ code: "DISCOUNT_APPROVAL_REQUIRED" });
  });

  it("credit above the limit is allowed up to the approved dues, for that customer", async () => {
    const boss = await owner();
    const cashier = await as("cashier");
    const productId = await product(boss);
    const { id: customerId } = await createCustomer(boss, { name: `Credit ${n}`, phone: String(9300000000 + n), type: "retail", creditLimit: "1000" });
    const credit = (quantity: string) => ({ customerId, lines: [{ productId, unit: "pc", quantity }] }) as unknown as BillInput;
    await expect(sell(cashier, credit("15"))).rejects.toMatchObject({ code: "CREDIT_LIMIT" });
    const request = await requestApproval(cashier, { action: "credit_over_limit", targetRef: customerId, targetLabel: "Credit", reason: "Regular buyer", amountPaise: 140000 });
    await approve(request.id);
    await expect(sell(cashier, credit("15"))).rejects.toMatchObject({ code: "CREDIT_LIMIT" }); // ₹1,500 > ₹1,400 approved
    const bill = await sell(cashier, credit("14"));
    expect(await partyBalance(shopA.shopId, "customer", customerId)).toBe(140000);
    const [audit] = await db.owner.select().from(auditLog).where(and(eq(auditLog.entityId, bill.id), eq(auditLog.action, "sales.invoice_issued")));
    expect(audit!.approvalId).toBe(request.id);
  });

  it("a manager corrects a bill only with the owner's approval for that bill; stock and dues end up right", async () => {
    const boss = await owner();
    const manager = await as("manager");
    const productId = await product(boss);
    const { id: customerId } = await createCustomer(boss, { name: `Fix ${n}`, phone: String(9400000000 + n), type: "retail", creditLimit: "100000" });
    const original = await sell(boss, { customerId, lines: [{ productId, unit: "pc", quantity: "5" }] } as unknown as BillInput); // ₹500 on credit
    const fixed = { customerId, lines: [{ productId, unit: "pc", quantity: "3" }] } as unknown as BillInput;
    const preview = await previewBill(manager, fixed);
    const input = { ...fixed, reason: "Customer took 3, not 5", idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates };
    await expect(correctInvoice(manager, original.id, input)).rejects.toMatchObject({ code: "OWNER_APPROVAL_REQUIRED" });
    const request = await requestApproval(manager, { action: "edit_invoice", targetRef: original.number, targetLabel: original.number, reason: "Wrong quantity" });
    await approve(request.id);
    const corrected = await correctInvoice(manager, original.id, input);
    expect(await correctInvoice(manager, original.id, input)).toMatchObject({ id: corrected.id, replayed: true });
    const [old] = await db.owner.select().from(invoices).where(eq(invoices.id, original.id));
    const [fresh] = await db.owner.select().from(invoices).where(eq(invoices.id, corrected.id));
    expect(old!.status).toBe("cancelled");
    expect(fresh).toMatchObject({ correctsInvoiceId: original.id, totalPaise: 30000 });
    expect(await partyBalance(shopA.shopId, "customer", customerId)).toBe(30000);
    expect(Number((await getProductStock(boss, productId)).qty)).toBe(497);
  });
});
