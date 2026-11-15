CREATE TABLE "cash_reconciliations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"kind" text DEFAULT 'confirm' NOT NULL,
	"as_of_date" date NOT NULL,
	"book_cash_paise" bigint NOT NULL,
	"counted_paise" bigint NOT NULL,
	"difference_paise" bigint NOT NULL,
	"reason" text NOT NULL,
	"journal_id" uuid,
	"reverses_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_reconciliations_reverses_key" UNIQUE("reverses_id"),
	CONSTRAINT "cash_reconciliations_kind_check" CHECK ("cash_reconciliations"."kind" in ('confirm', 'reversal'))
);
--> statement-breakpoint
CREATE TABLE "drawer_counts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"counted_paise" bigint NOT NULL,
	"note" text,
	"counted_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_kind_check";--> statement-breakpoint
ALTER TABLE "cash_movements" ADD COLUMN "bank_account_id" uuid;--> statement-breakpoint
ALTER TABLE "day_closings" ADD COLUMN "difference_journal_id" uuid;--> statement-breakpoint
ALTER TABLE "day_closings" ADD COLUMN "drawer_count_id" uuid;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "approval_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD COLUMN "approval_id" uuid;--> statement-breakpoint
ALTER TABLE "cash_reconciliations" ADD CONSTRAINT "cash_reconciliations_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_reconciliations" ADD CONSTRAINT "cash_reconciliations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawer_counts" ADD CONSTRAINT "drawer_counts_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawer_counts" ADD CONSTRAINT "drawer_counts_counted_by_users_id_fk" FOREIGN KEY ("counted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_reconciliations_shop_idx" ON "cash_reconciliations" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE INDEX "drawer_counts_shop_date_idx" ON "drawer_counts" USING btree ("shop_id","business_date","created_at");--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_kind_check" CHECK ("cash_movements"."kind" in ('withdrawal', 'bank_deposit', 'bank_withdrawal', 'float_added'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nexora_drawer_counts_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'drawer_counts: a count is never changed or removed; add a new count' USING ERRCODE = '23514';
END
$$;--> statement-breakpoint
CREATE TRIGGER "drawer_counts_append_only" BEFORE UPDATE OR DELETE ON "drawer_counts" FOR EACH ROW EXECUTE FUNCTION nexora_drawer_counts_append_only();--> statement-breakpoint
CREATE OR REPLACE FUNCTION nexora_cash_reconciliations_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cash_reconciliations: a confirmation is never removed; undo it with a reversal' USING ERRCODE = '23514';
  END IF;
  -- Only the journal can be filled in, once, right after the confirmation is saved.
  IF to_jsonb(OLD) - 'journal_id' IS DISTINCT FROM to_jsonb(NEW) - 'journal_id' OR (OLD."journal_id" IS NOT NULL AND OLD."journal_id" IS DISTINCT FROM NEW."journal_id") THEN
    RAISE EXCEPTION 'cash_reconciliations: a confirmation is never changed; undo it with a reversal' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "cash_reconciliations_append_only" BEFORE UPDATE OR DELETE ON "cash_reconciliations" FOR EACH ROW EXECUTE FUNCTION nexora_cash_reconciliations_append_only();--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexora_app') THEN
    GRANT SELECT, INSERT ON "drawer_counts" TO nexora_app;
    GRANT SELECT, INSERT, UPDATE ON "cash_reconciliations" TO nexora_app;
  END IF;
END
$$;--> statement-breakpoint
-- Role defaults for shops that already exist: the new permissions get their default grants, and a manager may close the day.
-- Anything the owner has already set for these permissions is left alone (existing rows are never overwritten).
INSERT INTO "role_permissions" ("shop_id", "role", "permission", "allowed")
SELECT s."id", p."role", p."permission", p."allowed"
FROM "shops" s
CROSS JOIN (VALUES
  ('owner', 'billing.return.limited', false), ('manager', 'billing.return.limited', false), ('cashier', 'billing.return.limited', true), ('inventory', 'billing.return.limited', false),
  ('owner', 'cash.view', true), ('manager', 'cash.view', true), ('cashier', 'cash.view', true), ('inventory', 'cash.view', false),
  ('owner', 'expense.small', false), ('manager', 'expense.small', false), ('cashier', 'expense.small', true), ('inventory', 'expense.small', false),
  ('owner', 'drawer.count', true), ('manager', 'drawer.count', true), ('cashier', 'drawer.count', true), ('inventory', 'drawer.count', false),
  ('owner', 'cash.reconcile', true), ('manager', 'cash.reconcile', false), ('cashier', 'cash.reconcile', false), ('inventory', 'cash.reconcile', false)
) AS p("role", "permission", "allowed")
ON CONFLICT ("shop_id", "role", "permission") DO NOTHING;--> statement-breakpoint
UPDATE "role_permissions" SET "allowed" = true WHERE "role" = 'manager' AND "permission" = 'day.close' AND "allowed" = false;
