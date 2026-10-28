import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createProduct, getProduct, updateProduct } from "@/modules/catalog";
import { countUnreadNotifications, listNotifications, markNotificationsRead } from "@/modules/identity";
import { commitImport, previewImport } from "@/modules/imports";
import { getProductStock, recordOpeningStock } from "@/modules/inventory";
import { appendLedgerEntry } from "@/modules/ledger";
import { createSupplier } from "@/modules/purchasing";
import { getDashboard, raiseBusinessAlerts, refreshBusinessAlerts } from "@/modules/reporting";
import { withTransaction } from "@/server/db";
import { indiaDate } from "@/shared/financial-year";
import { addDays } from "@/shared/report-range";
import { billShareText } from "@/shared/reminder";
import { createTestShop, signInAs } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const today = indiaDate();
let n = 0;

async function setup() {
  n += 1;
  const shop = await createTestShop(db, `Notify phase ${n}`);
  const sessions = Object.fromEntries(await Promise.all((["owner", "manager", "cashier", "inventory"] as const).map(async (role) => [role, (await signInAs(shop.users[role])).session])));
  return { shop, ...(sessions as Record<"owner" | "manager" | "cashier" | "inventory", Awaited<ReturnType<typeof signInAs>>["session"]>) };
}
/** A supplier the shop has owed for 40 days on 30-day terms. */
async function lateSupplier(shopId: string, session: Awaited<ReturnType<typeof signInAs>>["session"], owedPaise: number) {
  n += 1;
  const { id } = await createSupplier(session, { name: `Late supplier ${n}`, phone: "9000002200", paymentTermsDays: "30" });
  await withTransaction((tx) => appendLedgerEntry(tx, { shopId, partyType: "supplier", partyId: id, entryDate: addDays(today, -40), kind: "opening", sourceType: "opening_balance", sourceId: randomUUID(), creditPaise: owedPaise }));
  return id;
}

describe("overdue supplier alerts", () => {
  it("tells only the people who pay suppliers, once a week, from the dashboard's own figures", async () => {
    const { shop, owner, manager, inventory } = await setup();
    await lateSupplier(shop.shopId, owner, 250000);
    const { alerts } = await getDashboard(owner);
    expect(alerts.payables?.totals.overduePaise).toBe(250000);
    expect(await raiseBusinessAlerts(owner, alerts)).toBe(1);
    expect(await raiseBusinessAlerts(owner, alerts)).toBe(0); // reloaded: deduplicated
    expect(await refreshBusinessAlerts(manager)).toBe(0); // the notifications page agrees it's already raised

    const [alert] = (await listNotifications(owner)).filter((row) => row.kind === "supplier_overdue");
    expect(alert).toMatchObject({ href: "/reports/supplier-dues", body: expect.stringContaining("₹2,500") });
    // Managers and stock staff can see purchases but don't pay suppliers, so they don't get the amounts.
    expect((await listNotifications(manager)).filter((row) => row.kind === "supplier_overdue")).toEqual([]);
    expect((await listNotifications(inventory)).filter((row) => row.kind === "supplier_overdue")).toEqual([]);
  });

  it("stays inside the shop and can be read and cleared", async () => {
    const a = await setup();
    const b = await setup();
    await lateSupplier(a.shop.shopId, a.owner, 10000);
    await refreshBusinessAlerts(a.owner);
    expect(await refreshBusinessAlerts(b.owner)).toBe(0);
    expect(await listNotifications(b.owner)).toEqual([]);
    expect(await countUnreadNotifications(a.owner)).toBe(1);
    const [row] = await listNotifications(a.owner);
    expect(await markNotificationsRead(b.owner, row!.id)).toBe(0); // another shop can't clear it
    expect(await markNotificationsRead(a.owner, row!.id)).toBe(1);
    expect(await countUnreadNotifications(a.owner)).toBe(0);
  });
});

describe("low-stock level per product", () => {
  it("can be set and changed by the owner, drives the stock status, and refuses bad values", async () => {
    const { owner, manager } = await setup();
    const { id } = await createProduct(owner, { name: `Valve ${n}`, sku: `NP-${n}`, baseUnit: "pc", hsn: "8481", gstRateBp: "0", retailPaise: "100", wholesalePaise: "90", costPaise: "60", reorderLevel: "3" });
    await recordOpeningStock(owner, { idempotencyKey: key(), movementDate: today, lines: [{ productId: id, unit: "pc", quantity: "8" }] });
    expect((await getProductStock(owner, id)).status).toBe("healthy");
    const product = await getProduct(owner, id);
    expect(product.reorderLevel).toBe("3");
    const base = { name: product.name, sku: product.sku, baseUnit: "pc", hsn: product.hsn, gstRateBp: "0", retailPaise: "100", wholesalePaise: "90", costPaise: "60" };
    await updateProduct(owner, id, { ...base, version: product.version, reorderLevel: "10" });
    expect((await getProductStock(owner, id)).status).toBe("low");
    // Leaving it empty keeps the level that's there.
    await updateProduct(owner, id, { ...base, version: product.version + 1, reorderLevel: "" });
    expect((await getProduct(owner, id)).reorderLevel).toBe("10");
    for (const bad of ["-1", "abc", "1.2345"]) {
      await expect(updateProduct(owner, id, { ...base, version: product.version + 2, reorderLevel: bad }), bad).rejects.toBeTruthy();
    }
    await expect(updateProduct(manager, id, { ...base, version: product.version + 2, reorderLevel: "1" })).rejects.toThrow();
  });
});

describe("import finished", () => {
  it("tells the person who ran the import, once, with what was saved and left out", async () => {
    const { owner, manager } = await setup();
    const preview = await previewImport(owner, { type: "suppliers", text: "name\nOne Traders\nOne Traders\nTwo Traders" });
    await commitImport(owner, preview.id);
    await commitImport(owner, preview.id); // a repeat returns the saved result, without a second alert
    const finished = (await listNotifications(owner)).filter((row) => row.kind === "import_finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ title: "Suppliers import finished", body: expect.stringContaining("2 saved · 1 skipped"), href: `/settings/setup/imports/${preview.id}` });
    expect((await listNotifications(manager)).filter((row) => row.kind === "import_finished")).toEqual([]);
  });
});

describe("WhatsApp bill summary", () => {
  it("uses the saved bill's figures and only mentions dues when something is owed", () => {
    const facts = { shopName: "Sharma Sanitary", shopPhone: "98290 12345", upiId: "sharma@okhdfc", number: "INV/26-27/00012", date: "2026-10-28" };
    const credit = billShareText({ ...facts, customerName: "Gupta Builders", totalPaise: 100000, paidPaise: 40000 });
    expect(credit).toContain("Namaste Gupta Builders ji");
    expect(credit).toContain("Bill amount: ₹1,000.00");
    expect(credit).toContain("Payment mila: ₹400.00");
    expect(credit).toContain("baaki (udhaar): ₹600.00 · UPI: sharma@okhdfc");
    const paid = billShareText({ ...facts, customerName: null, totalPaise: 50000, paidPaise: 50000 });
    expect(paid).toMatch(/^Namaste 🙏/);
    expect(paid).toContain("Pura payment ho gaya.");
    expect(paid).not.toContain("UPI");
  });
});
