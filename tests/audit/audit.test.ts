import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { recordAudit, redact } from "@/modules/audit";
import { auditLog } from "@/modules/audit/schema";
import { withTransaction } from "@/server/db";
import { createTestShop, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
let shop: TestShop;

beforeAll(async () => {
  shop = await createTestShop(db);
});

const actor = () => ({ shopId: shop.shopId, userId: shop.users.owner.id, role: "owner" });

describe("audit helper", () => {
  it("commits the audit row together with its transaction", async () => {
    await withTransaction((tx) => recordAudit(tx, actor(), { action: "test.committed", entityType: "test", entityId: "commit-1" }));
    const rows = await db.owner.select().from(auditLog).where(eq(auditLog.entityId, "commit-1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ shopId: shop.shopId, userId: shop.users.owner.id, role: "owner", action: "test.committed" });
  });

  it("rolls the audit row back when the business operation fails", async () => {
    await expect(
      withTransaction(async (tx) => {
        await recordAudit(tx, actor(), { action: "test.rolled_back", entityType: "test", entityId: "rollback-1" });
        throw new Error("business rule failed");
      }),
    ).rejects.toThrow("business rule failed");
    const rows = await db.owner.select().from(auditLog).where(eq(auditLog.entityId, "rollback-1"));
    expect(rows).toHaveLength(0);
  });

  it("redacts secrets in before/after, including nested ones", async () => {
    await withTransaction((tx) =>
      recordAudit(tx, actor(), {
        action: "test.redaction",
        entityType: "test",
        entityId: "redact-1",
        after: { name: "Amit", otp: "123456", sessionToken: "abc", nested: { pinHash: "$argon2id$...", newPin: "2580", list: [{ setupToken: "s" }] } },
      }),
    );
    const [row] = await db.owner.select().from(auditLog).where(eq(auditLog.entityId, "redact-1"));
    expect(row!.after).toEqual({
      name: "Amit",
      otp: "[redacted]",
      sessionToken: "[redacted]",
      nested: { pinHash: "[redacted]", newPin: "[redacted]", list: [{ setupToken: "[redacted]" }] },
    });
  });

  it("keeps ordinary business fields", () => {
    expect(redact({ shopName: "A", stateCode: "08", totalPaise: 100 })).toEqual({ shopName: "A", stateCode: "08", totalPaise: 100 });
  });
});
