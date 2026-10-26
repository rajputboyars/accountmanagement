ALTER TABLE "expenses" ADD COLUMN "reference" varchar(40);--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "voided_by" uuid;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "void_reason" text;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_movements_shop_business_date_idx" ON "cash_movements" USING btree ("shop_id","business_date");--> statement-breakpoint
CREATE INDEX "expenses_shop_business_date_idx" ON "expenses" USING btree ("shop_id","business_date");--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_check" CHECK ("expenses"."category" in ('rent', 'salary', 'transport', 'electricity', 'tea', 'other'));--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_other_note_check" CHECK ("expenses"."category" <> 'other' or "expenses"."note" is not null);--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_void_check" CHECK ("expenses"."status" <> 'voided' or ("expenses"."voided_at" is not null and "expenses"."void_reason" is not null));