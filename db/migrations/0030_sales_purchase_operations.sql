CREATE TABLE "stock_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"godown_id" uuid NOT NULL,
	"qty_base" numeric(14, 3) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_reservations_order_line_key" UNIQUE("order_line_id"),
	CONSTRAINT "stock_reservations_qty_check" CHECK ("stock_reservations"."qty_base" > 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_return_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"purchase_return_id" uuid NOT NULL,
	"receipt_line_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"unit" text NOT NULL,
	"factor" numeric(12, 3) NOT NULL,
	"qty" numeric(14, 3) NOT NULL,
	"qty_base" numeric(14, 3) NOT NULL,
	"unit_cost_paise" bigint NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"gst_rate_bp" integer DEFAULT 0 NOT NULL,
	"gst_paise" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "purchase_return_lines_line_key" UNIQUE("purchase_return_id","receipt_line_id"),
	CONSTRAINT "purchase_return_lines_qty_check" CHECK ("purchase_return_lines"."qty_base" > 0 and "purchase_return_lines"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_returns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"fy" char(5) NOT NULL,
	"number" varchar(16) NOT NULL,
	"goods_receipt_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"godown_id" uuid NOT NULL,
	"return_date" date NOT NULL,
	"reason" text NOT NULL,
	"settlement" text NOT NULL,
	"refund_method" text,
	"refund_payment_id" uuid,
	"taxable_paise" bigint NOT NULL,
	"gst_paise" bigint DEFAULT 0 NOT NULL,
	"total_paise" bigint NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_returns_shop_fy_number_key" UNIQUE("shop_id","fy","number"),
	CONSTRAINT "purchase_returns_settlement_check" CHECK ("purchase_returns"."settlement" in ('credit', 'refund')),
	CONSTRAINT "purchase_returns_refund_check" CHECK (("purchase_returns"."settlement" = 'refund') = ("purchase_returns"."refund_method" is not null and "purchase_returns"."refund_payment_id" is not null)),
	CONSTRAINT "purchase_returns_total_check" CHECK ("purchase_returns"."total_paise" = "purchase_returns"."taxable_paise" + "purchase_returns"."gst_paise" and "purchase_returns"."total_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "delivery_challan_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"challan_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"unit" text NOT NULL,
	"factor" numeric(12, 3) NOT NULL,
	"qty" numeric(14, 3) NOT NULL,
	"base_qty" numeric(14, 3) NOT NULL,
	"unit_cost_paise" bigint,
	"product_name" text NOT NULL,
	CONSTRAINT "delivery_challan_lines_key" UNIQUE("challan_id","order_line_id"),
	CONSTRAINT "delivery_challan_lines_qty_check" CHECK ("delivery_challan_lines"."base_qty" > 0 and "delivery_challan_lines"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "delivery_challans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"fy" char(5) NOT NULL,
	"number" varchar(16) NOT NULL,
	"order_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"godown_id" uuid NOT NULL,
	"delivery_date" date NOT NULL,
	"note" text,
	"status" text DEFAULT 'delivered' NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_challans_shop_fy_number_key" UNIQUE("shop_id","fy","number"),
	CONSTRAINT "delivery_challans_status_check" CHECK ("delivery_challans"."status" in ('delivered', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "invoice_challan_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"invoice_line_id" uuid NOT NULL,
	"challan_line_id" uuid NOT NULL,
	"base_qty" numeric(14, 3) NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_challan_links_qty_check" CHECK ("invoice_challan_links"."base_qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "sales_order_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"product_id" uuid NOT NULL,
	"unit" text NOT NULL,
	"factor" numeric(12, 3) NOT NULL,
	"qty" numeric(14, 3) NOT NULL,
	"base_qty" numeric(14, 3) NOT NULL,
	"indicative_rate_paise" bigint NOT NULL,
	"product_name" text NOT NULL,
	CONSTRAINT "sales_order_lines_no_key" UNIQUE("order_id","line_no"),
	CONSTRAINT "sales_order_lines_qty_check" CHECK ("sales_order_lines"."base_qty" > 0 and "sales_order_lines"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "sales_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"fy" char(5) NOT NULL,
	"number" varchar(16) NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"order_date" date NOT NULL,
	"expected_date" date,
	"notes" text,
	"godown_id" uuid,
	"confirmed_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_orders_shop_fy_number_key" UNIQUE("shop_id","fy","number"),
	CONSTRAINT "sales_orders_status_check" CHECK ("sales_orders"."status" in ('draft', 'confirmed', 'partially_delivered', 'delivered', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_kind_check";--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "from_challans" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_godown_id_godowns_id_fk" FOREIGN KEY ("godown_id") REFERENCES "public"."godowns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_purchase_return_id_purchase_returns_id_fk" FOREIGN KEY ("purchase_return_id") REFERENCES "public"."purchase_returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_receipt_line_id_goods_receipt_lines_id_fk" FOREIGN KEY ("receipt_line_id") REFERENCES "public"."goods_receipt_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_goods_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("goods_receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_godown_id_godowns_id_fk" FOREIGN KEY ("godown_id") REFERENCES "public"."godowns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_refund_payment_id_payments_id_fk" FOREIGN KEY ("refund_payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_challan_lines" ADD CONSTRAINT "delivery_challan_lines_challan_id_delivery_challans_id_fk" FOREIGN KEY ("challan_id") REFERENCES "public"."delivery_challans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_challan_lines" ADD CONSTRAINT "delivery_challan_lines_order_line_id_sales_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."sales_order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_challan_lines" ADD CONSTRAINT "delivery_challan_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_challans" ADD CONSTRAINT "delivery_challans_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_challans" ADD CONSTRAINT "delivery_challans_order_id_sales_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."sales_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_challans" ADD CONSTRAINT "delivery_challans_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_challans" ADD CONSTRAINT "delivery_challans_godown_id_godowns_id_fk" FOREIGN KEY ("godown_id") REFERENCES "public"."godowns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_challans" ADD CONSTRAINT "delivery_challans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_challan_links" ADD CONSTRAINT "invoice_challan_links_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_challan_links" ADD CONSTRAINT "invoice_challan_links_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_challan_links" ADD CONSTRAINT "invoice_challan_links_invoice_line_id_invoice_lines_id_fk" FOREIGN KEY ("invoice_line_id") REFERENCES "public"."invoice_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_challan_links" ADD CONSTRAINT "invoice_challan_links_challan_line_id_delivery_challan_lines_id_fk" FOREIGN KEY ("challan_line_id") REFERENCES "public"."delivery_challan_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_order_id_sales_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."sales_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_godown_id_godowns_id_fk" FOREIGN KEY ("godown_id") REFERENCES "public"."godowns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_reservations_stock_idx" ON "stock_reservations" USING btree ("shop_id","product_id","godown_id");--> statement-breakpoint
CREATE INDEX "stock_reservations_order_idx" ON "stock_reservations" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "purchase_return_lines_receipt_line_idx" ON "purchase_return_lines" USING btree ("receipt_line_id");--> statement-breakpoint
CREATE INDEX "purchase_returns_receipt_idx" ON "purchase_returns" USING btree ("goods_receipt_id");--> statement-breakpoint
CREATE INDEX "purchase_returns_supplier_idx" ON "purchase_returns" USING btree ("supplier_id","return_date");--> statement-breakpoint
CREATE INDEX "delivery_challan_lines_order_line_idx" ON "delivery_challan_lines" USING btree ("order_line_id");--> statement-breakpoint
CREATE INDEX "delivery_challans_order_idx" ON "delivery_challans" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "invoice_challan_links_challan_line_idx" ON "invoice_challan_links" USING btree ("challan_line_id");--> statement-breakpoint
CREATE INDEX "invoice_challan_links_invoice_idx" ON "invoice_challan_links" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "sales_orders_shop_status_idx" ON "sales_orders" USING btree ("shop_id","status");--> statement-breakpoint
CREATE INDEX "sales_orders_customer_idx" ON "sales_orders" USING btree ("customer_id");--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_kind_check" CHECK ("stock_movements"."kind" in ('opening', 'sale', 'sale_cancel', 'return_in', 'purchase', 'return_out', 'damage', 'count', 'transfer_in', 'transfer_out', 'delivery', 'delivery_cancel'));--> statement-breakpoint
-- Hand-added. Returns, order lines, challan lines are append-only documents; challans and links change only their cancel/release fields;
-- orders change only their workflow fields; reservations are a working table the application keeps up to date.
CREATE TRIGGER "purchase_returns_append_only" BEFORE UPDATE OR DELETE ON "purchase_returns" FOR EACH ROW EXECUTE FUNCTION nexora_reject_mutation();--> statement-breakpoint
CREATE TRIGGER "purchase_return_lines_append_only" BEFORE UPDATE OR DELETE ON "purchase_return_lines" FOR EACH ROW EXECUTE FUNCTION nexora_reject_mutation();--> statement-breakpoint
CREATE TRIGGER "sales_order_lines_append_only" BEFORE UPDATE OR DELETE ON "sales_order_lines" FOR EACH ROW EXECUTE FUNCTION nexora_reject_mutation();--> statement-breakpoint
CREATE TRIGGER "delivery_challan_lines_append_only" BEFORE UPDATE OR DELETE ON "delivery_challan_lines" FOR EACH ROW EXECUTE FUNCTION nexora_reject_mutation();--> statement-breakpoint
CREATE TRIGGER "sales_orders_no_delete" BEFORE DELETE ON "sales_orders" FOR EACH ROW EXECUTE FUNCTION nexora_reject_mutation();--> statement-breakpoint
CREATE TRIGGER "delivery_challans_no_delete" BEFORE DELETE ON "delivery_challans" FOR EACH ROW EXECUTE FUNCTION nexora_reject_mutation();--> statement-breakpoint
CREATE TRIGGER "invoice_challan_links_no_delete" BEFORE DELETE ON "invoice_challan_links" FOR EACH ROW EXECUTE FUNCTION nexora_reject_mutation();--> statement-breakpoint
CREATE OR REPLACE FUNCTION nexora_challan_cancel_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD."id", OLD."shop_id", OLD."fy", OLD."number", OLD."order_id", OLD."customer_id", OLD."godown_id", OLD."delivery_date", OLD."created_by")
     IS DISTINCT FROM (NEW."id", NEW."shop_id", NEW."fy", NEW."number", NEW."order_id", NEW."customer_id", NEW."godown_id", NEW."delivery_date", NEW."created_by") THEN
    RAISE EXCEPTION 'delivery_challans: only the cancellation can change' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'cancelled' AND NEW."status" <> 'cancelled' THEN
    RAISE EXCEPTION 'delivery_challans: a cancelled challan stays cancelled' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "delivery_challans_cancel_only" BEFORE UPDATE ON "delivery_challans" FOR EACH ROW EXECUTE FUNCTION nexora_challan_cancel_only();--> statement-breakpoint
CREATE OR REPLACE FUNCTION nexora_link_release_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD."id", OLD."shop_id", OLD."invoice_id", OLD."invoice_line_id", OLD."challan_line_id", OLD."base_qty")
     IS DISTINCT FROM (NEW."id", NEW."shop_id", NEW."invoice_id", NEW."invoice_line_id", NEW."challan_line_id", NEW."base_qty") THEN
    RAISE EXCEPTION 'invoice_challan_links: only release can change' USING ERRCODE = '23514';
  END IF;
  IF OLD."released_at" IS NOT NULL AND NEW."released_at" IS DISTINCT FROM OLD."released_at" THEN
    RAISE EXCEPTION 'invoice_challan_links: a released link stays released' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "invoice_challan_links_release_only" BEFORE UPDATE ON "invoice_challan_links" FOR EACH ROW EXECUTE FUNCTION nexora_link_release_only();--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexora_app') THEN
    GRANT SELECT, INSERT ON "purchase_returns", "purchase_return_lines", "sales_order_lines", "delivery_challan_lines" TO nexora_app;
    GRANT SELECT, INSERT, UPDATE ON "sales_orders", "delivery_challans", "invoice_challan_links" TO nexora_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "stock_reservations" TO nexora_app;
  END IF;
END
$$;
