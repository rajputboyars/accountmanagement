CREATE TABLE "supplier_products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_products_supplier_product_key" UNIQUE("supplier_id","product_id")
);
--> statement-breakpoint
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_products_shop_supplier_idx" ON "supplier_products" USING btree ("shop_id","supplier_id");--> statement-breakpoint
CREATE INDEX "supplier_products_product_idx" ON "supplier_products" USING btree ("product_id");--> statement-breakpoint
-- Hand-added: keep every supplier's existing products visible by linking what past orders and receipts already used.
INSERT INTO "supplier_products" ("id", "shop_id", "supplier_id", "product_id")
SELECT gen_random_uuid(), pairs.shop_id, pairs.supplier_id, pairs.product_id
FROM (
  SELECT po.shop_id, po.supplier_id, pol.product_id
  FROM "purchase_order_lines" pol JOIN "purchase_orders" po ON po.id = pol.purchase_order_id
  UNION
  SELECT gr.shop_id, gr.supplier_id, grl.product_id
  FROM "goods_receipt_lines" grl JOIN "goods_receipts" gr ON gr.id = grl.goods_receipt_id
) AS pairs
ON CONFLICT ("supplier_id", "product_id") DO NOTHING;--> statement-breakpoint
-- Hand-added: the application role reads and writes the new table (see docs/database.md).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexora_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "supplier_products" TO nexora_app;
  END IF;
END
$$;
