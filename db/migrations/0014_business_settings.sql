ALTER TABLE "credit_notes" DROP CONSTRAINT "credit_notes_total_check";--> statement-breakpoint
ALTER TABLE "credit_notes" DROP CONSTRAINT "credit_notes_amounts_check";--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD COLUMN "igst_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD COLUMN "igst_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "igst_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "tax_mode" text DEFAULT 'intra' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "place_of_supply" char(2);--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "gst_registration" text DEFAULT 'regular' NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "inter_state_sales" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "gst_rates_bp" integer[] DEFAULT '{0,500,1200,1800,2800}'::integer[] NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "invoice_prefix" varchar(4) DEFAULT 'INV' NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_total_check" CHECK ("credit_notes"."total_paise" = "credit_notes"."taxable_paise" + "credit_notes"."cgst_paise" + "credit_notes"."sgst_paise" + "credit_notes"."igst_paise" + "credit_notes"."round_off_paise");--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_amounts_check" CHECK ("credit_notes"."taxable_paise" >= 0 and "credit_notes"."cgst_paise" >= 0 and "credit_notes"."sgst_paise" >= 0 and "credit_notes"."igst_paise" >= 0 and "credit_notes"."total_paise" >= 0);--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tax_mode_check" CHECK ("invoices"."tax_mode" in ('intra', 'inter', 'none'));--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tax_mode_amounts_check" CHECK (("invoices"."tax_mode" = 'intra' and "invoices"."igst_paise" = 0) or ("invoices"."tax_mode" = 'inter' and "invoices"."cgst_paise" = 0 and "invoices"."sgst_paise" = 0) or ("invoices"."tax_mode" = 'none' and "invoices"."cgst_paise" = 0 and "invoices"."sgst_paise" = 0 and "invoices"."igst_paise" = 0));--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_gst_registration_check" CHECK ("shops"."gst_registration" in ('regular', 'composition', 'unregistered'));--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_invoice_prefix_check" CHECK ("shops"."invoice_prefix" ~ '^[A-Z]{1,4}$');--> statement-breakpoint
-- Hand-added: `settings.edit` (business profile, GST and invoice settings) for existing shops, owner only.
INSERT INTO "role_permissions" ("shop_id", "role", "permission", "allowed")
SELECT "shops"."id", "roles"."role", 'settings.edit', "roles"."role" = 'owner'
FROM "shops" CROSS JOIN (VALUES ('owner'), ('manager'), ('cashier'), ('inventory')) AS "roles"("role")
ON CONFLICT DO NOTHING;
