CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"last4" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"opening_as_of" date NOT NULL,
	"opening_statement_paise" bigint NOT NULL,
	"opening_book_paise" bigint NOT NULL,
	"csv_mapping" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_accounts_shop_account_key" UNIQUE("shop_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "bank_match_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"posting_kind" text,
	"payment_id" uuid,
	"journal_id" uuid,
	"fee_paise" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_by" uuid,
	"undone_at" timestamp with time zone,
	"undo_reason" text,
	CONSTRAINT "bank_match_groups_kind_check" CHECK ("bank_match_groups"."kind" in ('match', 'settlement', 'posting')),
	CONSTRAINT "bank_match_groups_status_check" CHECK ("bank_match_groups"."status" in ('active', 'undone')),
	CONSTRAINT "bank_match_groups_fee_check" CHECK ("bank_match_groups"."fee_paise" >= 0),
	CONSTRAINT "bank_match_groups_posting_check" CHECK (("bank_match_groups"."kind" = 'posting') = ("bank_match_groups"."posting_kind" is not null))
);
--> statement-breakpoint
CREATE TABLE "bank_match_items" (
	"group_id" uuid NOT NULL,
	"journal_line_id" bigint NOT NULL,
	"signed_paise" bigint NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "bank_match_items_group_id_journal_line_id_pk" PRIMARY KEY("group_id","journal_line_id")
);
--> statement-breakpoint
CREATE TABLE "bank_match_lines" (
	"group_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "bank_match_lines_group_id_line_id_pk" PRIMARY KEY("group_id","line_id")
);
--> statement-breakpoint
CREATE TABLE "bank_reconciliations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"statement_date" date NOT NULL,
	"statement_balance_paise" bigint NOT NULL,
	"book_balance_paise" bigint NOT NULL,
	"opening_gap_paise" bigint NOT NULL,
	"book_not_in_bank_paise" bigint NOT NULL,
	"bank_not_in_books_paise" bigint NOT NULL,
	"difference_paise" bigint NOT NULL,
	"lines_balance_paise" bigint,
	"matched_count" integer NOT NULL,
	"outstanding" jsonb NOT NULL,
	"note" text,
	"finalized_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_reconciliations_date_key" UNIQUE("bank_account_id","statement_date")
);
--> statement-breakpoint
CREATE TABLE "bank_statement_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"txn_date" date NOT NULL,
	"narration" text NOT NULL,
	"reference" text,
	"debit_paise" bigint DEFAULT 0 NOT NULL,
	"credit_paise" bigint DEFAULT 0 NOT NULL,
	"balance_paise" bigint,
	"fingerprint" text NOT NULL,
	"occurrence" integer NOT NULL,
	"status" text DEFAULT 'unmatched' NOT NULL,
	"ignore_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_statement_lines_fingerprint_key" UNIQUE("bank_account_id","fingerprint","occurrence"),
	CONSTRAINT "bank_statement_lines_status_check" CHECK ("bank_statement_lines"."status" in ('unmatched', 'matched', 'ignored')),
	CONSTRAINT "bank_statement_lines_amount_check" CHECK ("bank_statement_lines"."debit_paise" >= 0 and "bank_statement_lines"."credit_paise" >= 0 and ("bank_statement_lines"."debit_paise" > 0) <> ("bank_statement_lines"."credit_paise" > 0)),
	CONSTRAINT "bank_statement_lines_occurrence_check" CHECK ("bank_statement_lines"."occurrence" >= 1)
);
--> statement-breakpoint
CREATE TABLE "bank_statements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"file_hash" text NOT NULL,
	"line_count" integer NOT NULL,
	"new_line_count" integer NOT NULL,
	"duplicate_line_count" integer NOT NULL,
	"from_date" date,
	"to_date" date,
	"imported_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_statements_file_key" UNIQUE("bank_account_id","file_hash")
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "bank_account_id" uuid;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_match_groups" ADD CONSTRAINT "bank_match_groups_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_match_groups" ADD CONSTRAINT "bank_match_groups_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_match_groups" ADD CONSTRAINT "bank_match_groups_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_match_groups" ADD CONSTRAINT "bank_match_groups_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_match_groups" ADD CONSTRAINT "bank_match_groups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_match_groups" ADD CONSTRAINT "bank_match_groups_undone_by_users_id_fk" FOREIGN KEY ("undone_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_match_items" ADD CONSTRAINT "bank_match_items_group_id_bank_match_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."bank_match_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_match_items" ADD CONSTRAINT "bank_match_items_journal_line_id_journal_lines_id_fk" FOREIGN KEY ("journal_line_id") REFERENCES "public"."journal_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_match_lines" ADD CONSTRAINT "bank_match_lines_group_id_bank_match_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."bank_match_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_match_lines" ADD CONSTRAINT "bank_match_lines_line_id_bank_statement_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."bank_statement_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_finalized_by_users_id_fk" FOREIGN KEY ("finalized_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_statement_id_bank_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."bank_statements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_imported_by_users_id_fk" FOREIGN KEY ("imported_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_shop_name_key" ON "bank_accounts" USING btree ("shop_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_one_default_key" ON "bank_accounts" USING btree ("shop_id") WHERE "bank_accounts"."is_default";--> statement-breakpoint
CREATE INDEX "bank_match_groups_account_idx" ON "bank_match_groups" USING btree ("shop_id","bank_account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_match_items_one_active_key" ON "bank_match_items" USING btree ("journal_line_id") WHERE "bank_match_items"."active";--> statement-breakpoint
CREATE UNIQUE INDEX "bank_match_lines_one_active_key" ON "bank_match_lines" USING btree ("line_id") WHERE "bank_match_lines"."active";--> statement-breakpoint
CREATE INDEX "bank_reconciliations_account_idx" ON "bank_reconciliations" USING btree ("shop_id","bank_account_id","statement_date");--> statement-breakpoint
CREATE INDEX "bank_statement_lines_account_date_idx" ON "bank_statement_lines" USING btree ("shop_id","bank_account_id","txn_date");--> statement-breakpoint
CREATE INDEX "bank_statement_lines_status_idx" ON "bank_statement_lines" USING btree ("bank_account_id","status");--> statement-breakpoint
CREATE INDEX "bank_statements_account_idx" ON "bank_statements" USING btree ("shop_id","bank_account_id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER "bank_statements_append_only" BEFORE UPDATE OR DELETE ON "bank_statements" FOR EACH ROW EXECUTE FUNCTION nexora_reject_mutation();--> statement-breakpoint
CREATE TRIGGER "bank_reconciliations_append_only" BEFORE UPDATE OR DELETE ON "bank_reconciliations" FOR EACH ROW EXECUTE FUNCTION nexora_reject_mutation();--> statement-breakpoint
CREATE TRIGGER "bank_accounts_no_delete" BEFORE DELETE ON "bank_accounts" FOR EACH ROW EXECUTE FUNCTION nexora_reject_mutation();--> statement-breakpoint
CREATE TRIGGER "bank_statement_lines_no_delete" BEFORE DELETE ON "bank_statement_lines" FOR EACH ROW EXECUTE FUNCTION nexora_reject_mutation();--> statement-breakpoint
CREATE TRIGGER "bank_match_groups_no_delete" BEFORE DELETE ON "bank_match_groups" FOR EACH ROW EXECUTE FUNCTION nexora_reject_mutation();--> statement-breakpoint
CREATE TRIGGER "bank_match_lines_no_delete" BEFORE DELETE ON "bank_match_lines" FOR EACH ROW EXECUTE FUNCTION nexora_reject_mutation();--> statement-breakpoint
CREATE TRIGGER "bank_match_items_no_delete" BEFORE DELETE ON "bank_match_items" FOR EACH ROW EXECUTE FUNCTION nexora_reject_mutation();--> statement-breakpoint
CREATE OR REPLACE FUNCTION nexora_bank_account_edit_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD."id", OLD."shop_id", OLD."account_id", OLD."is_default", OLD."opening_as_of", OLD."opening_statement_paise", OLD."created_by", OLD."created_at")
     IS DISTINCT FROM (NEW."id", NEW."shop_id", NEW."account_id", NEW."is_default", NEW."opening_as_of", NEW."opening_statement_paise", NEW."created_by", NEW."created_at") THEN
    RAISE EXCEPTION 'bank_accounts: only the name, last digits, on/off, saved columns and opening book figure can change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "bank_accounts_edit_only" BEFORE UPDATE ON "bank_accounts" FOR EACH ROW EXECUTE FUNCTION nexora_bank_account_edit_only();--> statement-breakpoint
CREATE OR REPLACE FUNCTION nexora_bank_line_status_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD."id", OLD."shop_id", OLD."statement_id", OLD."bank_account_id", OLD."txn_date", OLD."narration", OLD."reference", OLD."debit_paise", OLD."credit_paise", OLD."balance_paise", OLD."fingerprint", OLD."occurrence", OLD."created_at")
     IS DISTINCT FROM (NEW."id", NEW."shop_id", NEW."statement_id", NEW."bank_account_id", NEW."txn_date", NEW."narration", NEW."reference", NEW."debit_paise", NEW."credit_paise", NEW."balance_paise", NEW."fingerprint", NEW."occurrence", NEW."created_at") THEN
    RAISE EXCEPTION 'bank_statement_lines: only the status can change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "bank_statement_lines_status_only" BEFORE UPDATE ON "bank_statement_lines" FOR EACH ROW EXECUTE FUNCTION nexora_bank_line_status_only();--> statement-breakpoint
CREATE OR REPLACE FUNCTION nexora_bank_match_group_edit_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD."id", OLD."shop_id", OLD."bank_account_id", OLD."kind", OLD."posting_kind", OLD."fee_paise", OLD."created_by", OLD."created_at")
     IS DISTINCT FROM (NEW."id", NEW."shop_id", NEW."bank_account_id", NEW."kind", NEW."posting_kind", NEW."fee_paise", NEW."created_by", NEW."created_at") THEN
    RAISE EXCEPTION 'bank_match_groups: only the journal, payment and the undo can change' USING ERRCODE = '23514';
  END IF;
  IF (OLD."journal_id" IS NOT NULL AND OLD."journal_id" IS DISTINCT FROM NEW."journal_id") OR (OLD."payment_id" IS NOT NULL AND OLD."payment_id" IS DISTINCT FROM NEW."payment_id") THEN
    RAISE EXCEPTION 'bank_match_groups: the journal and payment are set once' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'undone' AND NEW."status" <> 'undone' THEN
    RAISE EXCEPTION 'bank_match_groups: an undone match stays undone' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "bank_match_groups_edit_only" BEFORE UPDATE ON "bank_match_groups" FOR EACH ROW EXECUTE FUNCTION nexora_bank_match_group_edit_only();--> statement-breakpoint
CREATE OR REPLACE FUNCTION nexora_bank_match_release_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."active" = false AND NEW."active" = true THEN
    RAISE EXCEPTION '%: a released match is not reopened; make a new one', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  IF to_jsonb(OLD) - 'active' IS DISTINCT FROM to_jsonb(NEW) - 'active' THEN
    RAISE EXCEPTION '%: only releasing a match can change', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "bank_match_lines_release_only" BEFORE UPDATE ON "bank_match_lines" FOR EACH ROW EXECUTE FUNCTION nexora_bank_match_release_only();--> statement-breakpoint
CREATE TRIGGER "bank_match_items_release_only" BEFORE UPDATE ON "bank_match_items" FOR EACH ROW EXECUTE FUNCTION nexora_bank_match_release_only();--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexora_app') THEN
    GRANT SELECT, INSERT ON "bank_statements", "bank_reconciliations" TO nexora_app;
    GRANT SELECT, INSERT, UPDATE ON "bank_accounts", "bank_statement_lines", "bank_match_groups", "bank_match_lines", "bank_match_items" TO nexora_app;
  END IF;
END
$$;
