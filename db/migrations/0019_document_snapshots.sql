ALTER TABLE "credit_notes" ADD COLUMN "seller" jsonb;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD COLUMN "buyer" jsonb;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "product_name" text;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "hsn" varchar(8);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "seller" jsonb;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "buyer" jsonb;