ALTER TABLE "customers" ADD COLUMN "whatsapp_consent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "consent_updated_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_receipt_number_key" ON "payments" USING btree ("shop_id","fy","receipt_number") WHERE "payments"."receipt_number" is not null;--> statement-breakpoint
-- Hand-added. New permission `payments.reverse` (owner only by default) for existing shops.
INSERT INTO "role_permissions" ("shop_id", "role", "permission", "allowed")
SELECT "shops"."id", "roles"."role", 'payments.reverse', "roles"."role" = 'owner'
FROM "shops" CROSS JOIN (VALUES ('owner'), ('manager'), ('cashier'), ('inventory')) AS "roles"("role")
ON CONFLICT DO NOTHING;
