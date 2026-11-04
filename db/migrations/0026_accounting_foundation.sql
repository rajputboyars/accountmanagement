CREATE TABLE "accounting_gaps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"ref" text DEFAULT '' NOT NULL,
	"entry_date" date NOT NULL,
	"note" text,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_gaps_kind_check" CHECK ("accounting_gaps"."kind" in ('cost_missing_for_sale', 'cost_missing_for_return', 'unvalued_stock_movement', 'unvalued_opening_stock'))
);
--> statement-breakpoint
CREATE TABLE "accounting_settings" (
	"shop_id" uuid PRIMARY KEY NOT NULL,
	"coverage_start_date" date NOT NULL,
	"input_gst_policy" text DEFAULT 'review' NOT NULL,
	"opening_status" text DEFAULT 'unverified' NOT NULL,
	"lock_through" date,
	"activated_by" uuid NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_settings_gst_policy_check" CHECK ("accounting_settings"."input_gst_policy" in ('review', 'recoverable', 'non_recoverable')),
	CONSTRAINT "accounting_settings_opening_status_check" CHECK ("accounting_settings"."opening_status" in ('unverified', 'verified'))
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"system_key" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"category" text NOT NULL,
	"cash_flow" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_shop_system_key_key" UNIQUE("shop_id","system_key"),
	CONSTRAINT "accounts_shop_code_key" UNIQUE("shop_id","code"),
	CONSTRAINT "accounts_type_check" CHECK ("accounts"."type" in ('asset', 'liability', 'equity', 'income', 'expense')),
	CONSTRAINT "accounts_cash_flow_check" CHECK ("accounts"."cash_flow" in ('operating', 'investing', 'financing', 'cash', 'none'))
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "journal_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"journal_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"debit_paise" bigint DEFAULT 0 NOT NULL,
	"credit_paise" bigint DEFAULT 0 NOT NULL,
	"party_type" text,
	"party_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_lines_debit_check" CHECK ("journal_lines"."debit_paise" >= 0),
	CONSTRAINT "journal_lines_credit_check" CHECK ("journal_lines"."credit_paise" >= 0),
	CONSTRAINT "journal_lines_one_side_check" CHECK (("journal_lines"."debit_paise" > 0) <> ("journal_lines"."credit_paise" > 0)),
	CONSTRAINT "journal_lines_party_check" CHECK (("journal_lines"."party_type" is null) = ("journal_lines"."party_id" is null) and ("journal_lines"."party_type" is null or "journal_lines"."party_type" in ('customer', 'supplier')))
);
--> statement-breakpoint
CREATE TABLE "journals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "journals_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"shop_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"kind" text DEFAULT 'event' NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"event" text NOT NULL,
	"memo" text,
	"reverses_journal_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journals_kind_check" CHECK ("journals"."kind" in ('event', 'opening', 'reversal', 'adjustment'))
);
--> statement-breakpoint
ALTER TABLE "accounting_gaps" ADD CONSTRAINT "accounting_gaps_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_gaps" ADD CONSTRAINT "accounting_gaps_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_settings" ADD CONSTRAINT "accounting_settings_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_settings" ADD CONSTRAINT "accounting_settings_activated_by_users_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_reverses_journal_id_journals_id_fk" FOREIGN KEY ("reverses_journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_gaps_key" ON "accounting_gaps" USING btree ("shop_id","kind","source_type","source_id","ref");--> statement-breakpoint
CREATE INDEX "accounting_gaps_open_idx" ON "accounting_gaps" USING btree ("shop_id","entry_date") WHERE "accounting_gaps"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "journal_lines_journal_idx" ON "journal_lines" USING btree ("journal_id");--> statement-breakpoint
CREATE INDEX "journal_lines_account_idx" ON "journal_lines" USING btree ("shop_id","account_id");--> statement-breakpoint
CREATE INDEX "journal_lines_party_idx" ON "journal_lines" USING btree ("party_type","party_id");--> statement-breakpoint
CREATE UNIQUE INDEX "journals_source_key" ON "journals" USING btree ("shop_id","source_type","source_id","event");--> statement-breakpoint
CREATE UNIQUE INDEX "journals_one_reversal_key" ON "journals" USING btree ("reverses_journal_id") WHERE "journals"."reverses_journal_id" is not null;--> statement-breakpoint
CREATE INDEX "journals_shop_date_idx" ON "journals" USING btree ("shop_id","entry_date","seq");--> statement-breakpoint
-- Hand-added: journals and their lines are append-only, like ledger_entries. A mistake is a reversing journal.
CREATE TRIGGER journals_append_only BEFORE UPDATE OR DELETE ON "journals"
  FOR EACH ROW EXECUTE FUNCTION nexora_reject_mutation();--> statement-breakpoint
CREATE TRIGGER journals_no_truncate BEFORE TRUNCATE ON "journals"
  FOR EACH STATEMENT EXECUTE FUNCTION nexora_reject_mutation();--> statement-breakpoint
CREATE TRIGGER journal_lines_append_only BEFORE UPDATE OR DELETE ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION nexora_reject_mutation();--> statement-breakpoint
CREATE TRIGGER journal_lines_no_truncate BEFORE TRUNCATE ON "journal_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION nexora_reject_mutation();--> statement-breakpoint
-- Hand-added: a journal must have at least two lines, equal debits and credits, and only its own shop's accounts.
-- Checked when the transaction commits, so lines can be inserted one at a time.
CREATE OR REPLACE FUNCTION nexora_check_journal_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  jid uuid;
  total_debit bigint;
  total_credit bigint;
  line_count integer;
  foreign_lines integer;
  parent_shop uuid;
BEGIN
  IF TG_TABLE_NAME = 'journals' THEN
    jid := NEW.id;
    IF NEW.reverses_journal_id IS NOT NULL THEN
      SELECT shop_id INTO parent_shop FROM journals WHERE id = NEW.reverses_journal_id;
      IF parent_shop IS DISTINCT FROM NEW.shop_id THEN
        RAISE EXCEPTION 'journal % reverses a journal of another shop', jid USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSE
    jid := NEW.journal_id;
  END IF;
  SELECT coalesce(sum(debit_paise), 0), coalesce(sum(credit_paise), 0), count(*)
    INTO total_debit, total_credit, line_count FROM journal_lines WHERE journal_id = jid;
  IF line_count < 2 THEN
    RAISE EXCEPTION 'journal % needs at least two lines', jid USING ERRCODE = '23514';
  END IF;
  IF total_debit <> total_credit THEN
    RAISE EXCEPTION 'journal % does not balance: debits % credits %', jid, total_debit, total_credit USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO foreign_lines
    FROM journal_lines l
    JOIN journals j ON j.id = l.journal_id
    LEFT JOIN accounts a ON a.id = l.account_id
   WHERE l.journal_id = jid AND (a.shop_id IS DISTINCT FROM j.shop_id OR l.shop_id <> j.shop_id);
  IF foreign_lines > 0 THEN
    RAISE EXCEPTION 'journal % has lines on another shop''s account', jid USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journals_balanced AFTER INSERT ON "journals"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nexora_check_journal_balanced();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON "journal_lines"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nexora_check_journal_balanced();--> statement-breakpoint
-- Hand-added: only the resolved_* columns of a gap may change; gaps are never deleted.
CREATE OR REPLACE FUNCTION nexora_gap_resolve_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.id, OLD.shop_id, OLD.kind, OLD.source_type, OLD.source_id, OLD.ref, OLD.entry_date, OLD.note, OLD.created_at)
     IS DISTINCT FROM (NEW.id, NEW.shop_id, NEW.kind, NEW.source_type, NEW.source_id, NEW.ref, NEW.entry_date, NEW.note, NEW.created_at) THEN
    RAISE EXCEPTION 'accounting_gaps: only resolved_at and resolved_by may change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER accounting_gaps_resolve_only BEFORE UPDATE ON "accounting_gaps"
  FOR EACH ROW EXECUTE FUNCTION nexora_gap_resolve_only();--> statement-breakpoint
CREATE TRIGGER accounting_gaps_no_delete BEFORE DELETE ON "accounting_gaps"
  FOR EACH ROW EXECUTE FUNCTION nexora_reject_mutation();--> statement-breakpoint
-- Hand-added: an account's identity (key, code, type, cash-flow class, shop) is fixed; only its name and active flag change.
CREATE OR REPLACE FUNCTION nexora_account_identity_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.id, OLD.shop_id, OLD.system_key, OLD.code, OLD.type, OLD.cash_flow)
     IS DISTINCT FROM (NEW.id, NEW.shop_id, NEW.system_key, NEW.code, NEW.type, NEW.cash_flow) THEN
    RAISE EXCEPTION 'accounts: key, code, type and cash-flow class cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER accounts_identity_fixed BEFORE UPDATE ON "accounts"
  FOR EACH ROW EXECUTE FUNCTION nexora_account_identity_fixed();--> statement-breakpoint
CREATE TRIGGER accounts_no_delete BEFORE DELETE ON "accounts"
  FOR EACH ROW EXECUTE FUNCTION nexora_reject_mutation();--> statement-breakpoint
-- Hand-added: the application role may read and add journals but never change or remove them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexora_app') THEN
    GRANT SELECT, INSERT ON "journals", "journal_lines" TO nexora_app;
    GRANT SELECT, INSERT, UPDATE ON "accounts", "accounting_settings", "accounting_gaps" TO nexora_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nexora_app;
  END IF;
END
$$;
