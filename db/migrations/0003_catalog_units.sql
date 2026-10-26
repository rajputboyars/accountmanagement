CREATE TABLE "units" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"code" varchar(16) NOT NULL,
	"name" varchar(40) NOT NULL,
	"allow_decimal" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "units_shop_code_key" UNIQUE("shop_id","code"),
	CONSTRAINT "units_code_check" CHECK ("units"."code" ~ '^[a-z][a-z0-9]{0,15}$')
);
--> statement-breakpoint
ALTER TABLE "product_units" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "description" varchar(500);--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Hand-added backfill (before the base-unit foreign key): every existing shop gets the default
-- units, plus any unit codes its products already use, so existing data satisfies the new constraint.
INSERT INTO "units" ("id", "shop_id", "code", "name", "allow_decimal")
SELECT gen_random_uuid(), s."id", d.code, d.name, d.allow_decimal
FROM "shops" s
CROSS JOIN (VALUES
  ('pc', 'Piece', false), ('box', 'Box', false), ('bundle', 'Bundle', false), ('m', 'Meter', true),
  ('length', 'Length', false), ('kg', 'Kilogram', true), ('bag', 'Bag', false), ('ltr', 'Litre', true),
  ('set', 'Set', false)
) AS d(code, name, allow_decimal)
ON CONFLICT ("shop_id", "code") DO NOTHING;--> statement-breakpoint
INSERT INTO "units" ("id", "shop_id", "code", "name", "allow_decimal")
SELECT gen_random_uuid(), used.shop_id, used.code, initcap(used.code), false
FROM (
  SELECT p."shop_id", p."base_unit" AS code FROM "products" p
  UNION
  SELECT p."shop_id", pu."unit" FROM "product_units" pu JOIN "products" p ON p."id" = pu."product_id"
) AS used
ON CONFLICT ("shop_id", "code") DO NOTHING;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_base_unit_fkey" FOREIGN KEY ("shop_id","base_unit") REFERENCES "public"."units"("shop_id","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexora_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "units" TO nexora_app;
  END IF;
END
$$;
