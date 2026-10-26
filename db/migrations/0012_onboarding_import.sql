ALTER TABLE "import_jobs" DROP CONSTRAINT "import_jobs_type_check";--> statement-breakpoint
ALTER TABLE "import_jobs" DROP CONSTRAINT "import_jobs_status_check";--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "file_name" text;--> statement-breakpoint
ALTER TABLE "import_rows" ADD COLUMN "entity_id" uuid;--> statement-breakpoint
CREATE INDEX "import_jobs_shop_created_idx" ON "import_jobs" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "import_jobs_committed_file_key" ON "import_jobs" USING btree ("shop_id","type","file_key") WHERE "import_jobs"."status" = 'committed';--> statement-breakpoint
CREATE UNIQUE INDEX "import_rows_job_row_key" ON "import_rows" USING btree ("import_job_id","row_no");--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_type_check" CHECK ("import_jobs"."type" in ('products', 'customers', 'suppliers', 'opening_stock'));--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_status_check" CHECK ("import_jobs"."status" in ('uploaded', 'previewed', 'committing', 'committed', 'failed'));