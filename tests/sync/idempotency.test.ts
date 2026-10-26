import { randomUUID } from "node:crypto";
import { count, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { categories } from "@/modules/catalog/schema";
import { hashRequest, withIdempotency } from "@/modules/sync";
import { withTransaction } from "@/server/db";
import { ConflictError, ValidationError } from "@/server/errors";
import { createTestShop, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
let shop: TestShop;

beforeAll(async () => {
  shop = await createTestShop(db);
});

/** A stand-in "operation" with a visible side effect: it inserts one category row. */
function makeOperation(name: string) {
  const runs = { count: 0 };
  const run = (key: string, body: unknown, userId = shop.users.cashier.id) =>
    withTransaction((tx) =>
      withIdempotency(tx, { shopId: shop.shopId, userId, key }, body, async () => {
        runs.count++;
        const [row] = await tx.insert(categories).values({ shopId: shop.shopId, name }).returning({ id: categories.id });
        return { status: 201, body: { categoryId: row!.id } };
      }),
    );
  return { runs, run };
}

const categoryCount = async (name: string) => (await db.owner.select({ n: count() }).from(categories).where(eq(categories.name, name)))[0]!.n;

describe("idempotency helper", () => {
  it("runs concurrent duplicates once and returns the same response to all of them", async () => {
    const key = randomUUID();
    const { runs, run } = makeOperation("Concurrent");
    const results = await Promise.all(Array.from({ length: 5 }, () => run(key, { amountPaise: 3925200 })));

    expect(runs.count).toBe(1);
    expect(await categoryCount("Concurrent")).toBe(1);
    expect(new Set(results.map((r) => r.body.categoryId)).size).toBe(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(4);
    expect(results.every((r) => r.status === 201)).toBe(true);
  });

  it("replays a sequential retry without running again", async () => {
    const key = randomUUID();
    const { runs, run } = makeOperation("Retry");
    const first = await run(key, { a: 1, b: 2 });
    const second = await run(key, { b: 2, a: 1 }); // same body, different key order
    expect(runs.count).toBe(1);
    expect(second).toEqual({ ...first, replayed: true });
  });

  it("refuses the same key with a different body", async () => {
    const key = randomUUID();
    const { run } = makeOperation("Conflict");
    await run(key, { amountPaise: 100 });
    await expect(run(key, { amountPaise: 999 })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("refuses the same key from a different user", async () => {
    const key = randomUUID();
    const { run } = makeOperation("OtherUser");
    await run(key, { x: 1 });
    await expect(run(key, { x: 1 }, shop.users.manager.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("releases the key when the operation fails, so a retry can succeed", async () => {
    const key = randomUUID();
    await expect(
      withTransaction((tx) =>
        withIdempotency(tx, { shopId: shop.shopId, userId: shop.users.cashier.id, key }, { x: 1 }, async () => {
          throw new Error("stock check failed");
        }),
      ),
    ).rejects.toThrow("stock check failed");
    const { runs, run } = makeOperation("AfterFailure");
    await expect(run(key, { x: 1 })).resolves.toMatchObject({ replayed: false, status: 201 });
    expect(runs.count).toBe(1);
  });

  it("validates the key format", async () => {
    const { run } = makeOperation("BadKey");
    await expect(run("short", {})).rejects.toBeInstanceOf(ValidationError);
    await expect(run("has spaces in it", {})).rejects.toBeInstanceOf(ValidationError);
  });

  it("hashes bodies independently of key order", () => {
    expect(hashRequest({ a: 1, b: { c: 2, d: 3 } })).toBe(hashRequest({ b: { d: 3, c: 2 }, a: 1 }));
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }));
  });
});
