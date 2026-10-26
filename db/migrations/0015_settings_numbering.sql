ALTER TABLE "products" DROP CONSTRAINT "products_gst_rate_check";--> statement-breakpoint
ALTER TABLE "number_series" ADD COLUMN "start_value" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_gst_rate_check" CHECK ("products"."gst_rate_bp" in (0, 10, 25, 150, 300, 500, 1200, 1800, 2800, 4000));