DROP INDEX "goods_receipts_supplier_bill_key";--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD COLUMN "unit" text;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD COLUMN "factor" numeric(12, 3) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD COLUMN "qty" numeric(14, 3);--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD COLUMN "cost_paise_per_unit" bigint;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD COLUMN "gst_rate_bp" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD COLUMN "gst_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD COLUMN "status" text DEFAULT 'received' NOT NULL;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD COLUMN "cancelled_by" uuid;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goods_receipt_lines_receipt_idx" ON "goods_receipt_lines" USING btree ("goods_receipt_id");--> statement-breakpoint
CREATE INDEX "goods_receipt_lines_po_line_idx" ON "goods_receipt_lines" USING btree ("purchase_order_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipts_supplier_bill_active_key" ON "goods_receipts" USING btree ("supplier_id","supplier_bill_no") WHERE "goods_receipts"."supplier_bill_no" is not null and "goods_receipts"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "goods_receipts_supplier_idx" ON "goods_receipts" USING btree ("supplier_id","received_date");--> statement-breakpoint
CREATE INDEX "goods_receipts_purchase_order_idx" ON "goods_receipts" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "purchase_order_lines_order_idx" ON "purchase_order_lines" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_supplier_idx" ON "purchase_orders" USING btree ("supplier_id","order_date");--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_gst_rate_check" CHECK ("goods_receipt_lines"."gst_rate_bp" in (0, 500, 1200, 1800, 2800));--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_status_check" CHECK ("goods_receipts"."status" in ('received', 'cancelled'));--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_total_check" CHECK ("goods_receipts"."total_paise" = "goods_receipts"."taxable_paise" + "goods_receipts"."gst_paise");--> statement-breakpoint
-- Hand-added. New permission `purchases.cancel` (owner only by default) for shops created before it existed.
INSERT INTO "role_permissions" ("shop_id", "role", "permission", "allowed")
SELECT "shops"."id", "roles"."role", 'purchases.cancel', "roles"."role" = 'owner'
FROM "shops" CROSS JOIN (VALUES ('owner'), ('manager'), ('cashier'), ('inventory')) AS "roles"("role")
ON CONFLICT DO NOTHING;
