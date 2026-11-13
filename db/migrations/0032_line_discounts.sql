ALTER TABLE "invoice_lines" ADD COLUMN "discount_kind" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "discount_value" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "item_discount_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "item_discount_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_discount_kind_check" CHECK ("invoice_lines"."discount_kind" in ('none', 'flat', 'percent'));--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_item_discount_check" CHECK ("invoice_lines"."item_discount_paise" between 0 and "invoice_lines"."line_paise");