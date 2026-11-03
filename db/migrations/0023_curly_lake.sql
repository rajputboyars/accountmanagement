CREATE TABLE "user_guidance" (
	"shop_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"status" text NOT NULL,
	"step" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_guidance_user_id_kind_key_pk" PRIMARY KEY("user_id","kind","key"),
	CONSTRAINT "user_guidance_kind_check" CHECK ("user_guidance"."kind" in ('tip', 'task')),
	CONSTRAINT "user_guidance_step_check" CHECK ("user_guidance"."step" >= 0)
);
--> statement-breakpoint
ALTER TABLE "user_guidance" ADD CONSTRAINT "user_guidance_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_guidance" ADD CONSTRAINT "user_guidance_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_guidance_shop_user_idx" ON "user_guidance" USING btree ("shop_id","user_id");--> statement-breakpoint
-- Hand-added: the application role reads and writes the new table (see docs/database.md).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexora_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "user_guidance" TO nexora_app;
  END IF;
END
$$;
