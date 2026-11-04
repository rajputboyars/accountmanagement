-- Phase 2: godowns. Hand-ordered so existing stock is moved into each shop's silently created "Main Store" and verified
-- before anything is made stricter. The whole file runs in one transaction: if the final check finds any difference in a
-- product's quantity, a movement count or a cache row, it raises and nothing is applied.
CREATE TABLE "godowns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"name" varchar(60) NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "godowns_default_active_check" CHECK (not "godowns"."is_default" or "godowns"."is_active")
);--> statement-breakpoint
ALTER TABLE "godowns" ADD CONSTRAINT "godowns_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "godowns" ADD CONSTRAINT "godowns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "godowns_one_default_key" ON "godowns" USING btree ("shop_id") WHERE "godowns"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "godowns_shop_name_key" ON "godowns" USING btree ("shop_id",lower("name"));--> statement-breakpoint
CREATE TABLE "stock_transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"fy" char(5) NOT NULL,
	"number" varchar(16) NOT NULL,
	"from_godown_id" uuid NOT NULL,
	"to_godown_id" uuid NOT NULL,
	"transfer_date" date NOT NULL,
	"reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_transfers_shop_fy_number_key" UNIQUE("shop_id","fy","number"),
	CONSTRAINT "stock_transfers_distinct_check" CHECK ("stock_transfers"."from_godown_id" <> "stock_transfers"."to_godown_id")
);--> statement-breakpoint
CREATE TABLE "stock_transfer_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"transfer_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"unit" text NOT NULL,
	"factor" numeric(12, 3) NOT NULL,
	"qty" numeric(14, 3) NOT NULL,
	"base_qty" numeric(14, 3) NOT NULL,
	"unit_cost_paise" bigint,
	CONSTRAINT "stock_transfer_lines_product_key" UNIQUE("transfer_id","product_id"),
	CONSTRAINT "stock_transfer_lines_qty_check" CHECK ("stock_transfer_lines"."base_qty" > 0 and "stock_transfer_lines"."qty" > 0)
);--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_from_godown_id_godowns_id_fk" FOREIGN KEY ("from_godown_id") REFERENCES "public"."godowns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_godown_id_godowns_id_fk" FOREIGN KEY ("to_godown_id") REFERENCES "public"."godowns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_transfer_id_stock_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."stock_transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_transfers_shop_date_idx" ON "stock_transfers" USING btree ("shop_id","transfer_date");--> statement-breakpoint
-- Every shop gets one default Main Store, silently. Safe to repeat.
INSERT INTO "godowns" ("id", "shop_id", "name", "is_default", "is_active")
SELECT gen_random_uuid(), s."id", 'Main Store', true, true FROM "shops" s
ON CONFLICT ("shop_id") WHERE "is_default" DO NOTHING;--> statement-breakpoint
-- What must not change: per-product quantity and movement count, and the cache's per-product total and row count.
CREATE TEMP TABLE "_p2_movements" ON COMMIT DROP AS
SELECT "product_id", sum("qty_base") AS "qty", count(*) AS "n" FROM "stock_movements" GROUP BY "product_id";--> statement-breakpoint
CREATE TEMP TABLE "_p2_cache" ON COMMIT DROP AS
SELECT "product_id", sum("qty_base") AS "qty", count(*) AS "n" FROM "stock_levels" GROUP BY "product_id";--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "godown_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "entered_qty" numeric(14, 3);--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "entered_unit" text;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "entered_factor" numeric(12, 3);--> statement-breakpoint
ALTER TABLE "stock_levels" ADD COLUMN "godown_id" uuid;--> statement-breakpoint
-- stock_movements is append-only. The owner role lifts that rule for this one statement, inside this transaction, only to
-- stamp the new column; no quantity, date, kind or source is touched, and the rule is back before the transaction ends.
ALTER TABLE "stock_movements" DISABLE TRIGGER "stock_movements_append_only";--> statement-breakpoint
UPDATE "stock_movements" m SET "godown_id" = g."id" FROM "godowns" g WHERE g."shop_id" = m."shop_id" AND g."is_default";--> statement-breakpoint
ALTER TABLE "stock_movements" ENABLE TRIGGER "stock_movements_append_only";--> statement-breakpoint
UPDATE "stock_levels" l SET "godown_id" = g."id" FROM "godowns" g WHERE g."shop_id" = l."shop_id" AND g."is_default";--> statement-breakpoint
ALTER TABLE "stock_movements" ALTER COLUMN "godown_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_levels" ALTER COLUMN "godown_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_levels" DROP CONSTRAINT "stock_levels_pkey";--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_product_id_godown_id_pk" PRIMARY KEY("product_id","godown_id");--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_godown_id_godowns_id_fk" FOREIGN KEY ("godown_id") REFERENCES "public"."godowns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_godown_id_godowns_id_fk" FOREIGN KEY ("godown_id") REFERENCES "public"."godowns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_movements_godown_product_idx" ON "stock_movements" USING btree ("godown_id","product_id","id");--> statement-breakpoint
DROP INDEX "stock_movements_one_opening_key";--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_one_opening_key" ON "stock_movements" USING btree ("product_id","godown_id") WHERE "stock_movements"."kind" = 'opening';--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_kind_check";--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_kind_check" CHECK ("stock_movements"."kind" in ('opening', 'sale', 'sale_cancel', 'return_in', 'purchase', 'return_out', 'damage', 'count', 'transfer_in', 'transfer_out'));--> statement-breakpoint
-- The check: abort the whole migration unless everything is exactly as it was, now with a godown on every row.
DO $$
DECLARE
  bad integer;
BEGIN
  SELECT count(*) INTO bad FROM "stock_movements" WHERE "godown_id" IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'godown backfill left % movements without a godown', bad; END IF;
  SELECT count(*) INTO bad FROM "stock_levels" WHERE "godown_id" IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'godown backfill left % cache rows without a godown', bad; END IF;
  SELECT count(*) INTO bad FROM (
    SELECT b."product_id" FROM "_p2_movements" b
    FULL JOIN (SELECT "product_id", sum("qty_base") AS "qty", count(*) AS "n" FROM "stock_movements" GROUP BY "product_id") a USING ("product_id")
    WHERE a."qty" IS DISTINCT FROM b."qty" OR a."n" IS DISTINCT FROM b."n"
  ) d;
  IF bad > 0 THEN RAISE EXCEPTION 'godown backfill changed % products'' movement totals or counts', bad; END IF;
  SELECT count(*) INTO bad FROM (
    SELECT b."product_id" FROM "_p2_cache" b
    FULL JOIN (SELECT "product_id", sum("qty_base") AS "qty", count(*) AS "n" FROM "stock_levels" GROUP BY "product_id") a USING ("product_id")
    WHERE a."qty" IS DISTINCT FROM b."qty" OR a."n" IS DISTINCT FROM b."n"
  ) d;
  IF bad > 0 THEN RAISE EXCEPTION 'godown backfill changed % products'' cache rows', bad; END IF;
  SELECT count(*) INTO bad FROM "stock_movements" m JOIN "godowns" g ON g."id" = m."godown_id" WHERE g."shop_id" <> m."shop_id";
  IF bad > 0 THEN RAISE EXCEPTION 'godown backfill crossed shops for % movements', bad; END IF;
END
$$;--> statement-breakpoint
-- A godown is never deleted (history keeps pointing at it); transfers are append-only like every other journal.
CREATE TRIGGER "godowns_no_delete" BEFORE DELETE ON "godowns" FOR EACH ROW EXECUTE FUNCTION nexora_reject_mutation();--> statement-breakpoint
CREATE TRIGGER "stock_transfers_append_only" BEFORE UPDATE OR DELETE ON "stock_transfers" FOR EACH ROW EXECUTE FUNCTION nexora_reject_mutation();--> statement-breakpoint
CREATE TRIGGER "stock_transfer_lines_append_only" BEFORE UPDATE OR DELETE ON "stock_transfer_lines" FOR EACH ROW EXECUTE FUNCTION nexora_reject_mutation();--> statement-breakpoint
-- Only a godown's name and active flag may change.
CREATE OR REPLACE FUNCTION nexora_godown_identity_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD."id", OLD."shop_id", OLD."is_default", OLD."created_at") IS DISTINCT FROM (NEW."id", NEW."shop_id", NEW."is_default", NEW."created_at") THEN
    RAISE EXCEPTION 'godowns: only the name and the active flag can change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "godowns_identity_fixed" BEFORE UPDATE ON "godowns" FOR EACH ROW EXECUTE FUNCTION nexora_godown_identity_fixed();--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexora_app') THEN
    GRANT SELECT, INSERT, UPDATE ON "godowns" TO nexora_app;
    GRANT SELECT, INSERT ON "stock_transfers", "stock_transfer_lines" TO nexora_app;
  END IF;
END
$$;
