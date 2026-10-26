ALTER TABLE "price_slabs" DROP CONSTRAINT "price_slabs_product_min_qty_key";--> statement-breakpoint
ALTER TABLE "price_slabs" ADD COLUMN "shop_id" uuid;--> statement-breakpoint
-- Hand-edited: existing slabs take their product's shop before the column becomes NOT NULL.
UPDATE "price_slabs" SET "shop_id" = "products"."shop_id" FROM "products" WHERE "products"."id" = "price_slabs"."product_id";--> statement-breakpoint
ALTER TABLE "price_slabs" ALTER COLUMN "shop_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "price_slabs" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "price_slabs" ADD CONSTRAINT "price_slabs_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_price_rules_active_fixed_key" ON "customer_price_rules" USING btree ("customer_id","product_id","min_qty") WHERE "customer_price_rules"."is_active" and "customer_price_rules"."kind" = 'fixed';--> statement-breakpoint
CREATE UNIQUE INDEX "customer_price_rules_active_pct_product_key" ON "customer_price_rules" USING btree ("customer_id","product_id") WHERE "customer_price_rules"."is_active" and "customer_price_rules"."kind" = 'pct' and "customer_price_rules"."product_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_price_rules_active_pct_all_key" ON "customer_price_rules" USING btree ("customer_id") WHERE "customer_price_rules"."is_active" and "customer_price_rules"."kind" = 'pct' and "customer_price_rules"."product_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "price_slabs_active_min_qty_key" ON "price_slabs" USING btree ("product_id","min_qty") WHERE "price_slabs"."is_active";--> statement-breakpoint
CREATE INDEX "price_slabs_shop_product_idx" ON "price_slabs" USING btree ("shop_id","product_id");--> statement-breakpoint
ALTER TABLE "customer_price_rules" ADD CONSTRAINT "customer_price_rules_pct_range_check" CHECK ("customer_price_rules"."kind" <> 'pct' or "customer_price_rules"."value" between 10 and 3000);--> statement-breakpoint
ALTER TABLE "customer_price_rules" ADD CONSTRAINT "customer_price_rules_fixed_product_check" CHECK ("customer_price_rules"."kind" <> 'fixed' or "customer_price_rules"."product_id" is not null);--> statement-breakpoint
ALTER TABLE "customer_price_rules" ADD CONSTRAINT "customer_price_rules_min_qty_check" CHECK ("customer_price_rules"."min_qty" >= 0);