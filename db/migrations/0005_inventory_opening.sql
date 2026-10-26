CREATE UNIQUE INDEX "stock_movements_one_opening_key" ON "stock_movements" USING btree ("product_id") WHERE "stock_movements"."kind" = 'opening';--> statement-breakpoint
-- Hand-added. stock_levels is a cache of v_stock: create the missing rows for products that already
-- have movements (for example sample opening stock loaded before the cache was maintained).
-- Existing cache rows are left untouched; the inventory screen flags any that disagree with the ledger.
INSERT INTO "stock_levels" ("product_id", "shop_id", "qty_base", "last_movement_id")
SELECT "product_id", min("shop_id"::text)::uuid, sum("qty_base"), max("id")
FROM "stock_movements"
WHERE "product_id" NOT IN (SELECT "product_id" FROM "stock_levels")
GROUP BY "product_id";--> statement-breakpoint
-- Hand-added. New permission `stock.opening` (owner only by default) for shops created before it existed.
INSERT INTO "role_permissions" ("shop_id", "role", "permission", "allowed")
SELECT "shops"."id", "roles"."role", 'stock.opening', "roles"."role" = 'owner'
FROM "shops" CROSS JOIN (VALUES ('owner'), ('manager'), ('cashier'), ('inventory')) AS "roles"("role")
ON CONFLICT DO NOTHING;
