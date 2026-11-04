CREATE TABLE "accounting_gap_resolutions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"gap_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit_cost_paise" bigint,
	"value_paise" bigint NOT NULL,
	"source" text NOT NULL,
	"confirmed_by" uuid NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_gap_resolutions_key" UNIQUE("gap_id","idempotency_key"),
	CONSTRAINT "accounting_gap_resolutions_value_check" CHECK ("accounting_gap_resolutions"."value_paise" > 0 and "accounting_gap_resolutions"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "accounting_gap_resolutions" ADD CONSTRAINT "accounting_gap_resolutions_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_gap_resolutions" ADD CONSTRAINT "accounting_gap_resolutions_gap_id_accounting_gaps_id_fk" FOREIGN KEY ("gap_id") REFERENCES "public"."accounting_gaps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_gap_resolutions" ADD CONSTRAINT "accounting_gap_resolutions_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounting_gap_resolutions_gap_idx" ON "accounting_gap_resolutions" USING btree ("gap_id");--> statement-breakpoint
-- Hand-added: confirmations are append-only; the application role reads and adds them.
CREATE TRIGGER accounting_gap_resolutions_append_only BEFORE UPDATE OR DELETE ON "accounting_gap_resolutions"
  FOR EACH ROW EXECUTE FUNCTION nexora_reject_mutation();--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexora_app') THEN
    GRANT SELECT, INSERT ON "accounting_gap_resolutions" TO nexora_app;
  END IF;
END
$$;
