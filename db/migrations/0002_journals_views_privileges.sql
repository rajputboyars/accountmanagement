-- Hand-written. Objects Drizzle cannot express (Technical Architecture sections 2–4).

-- 1. Journals are append-only. Mistakes are fixed with new reversing rows, never edits.
CREATE OR REPLACE FUNCTION nexora_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Write a reversing entry instead of changing history.';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION nexora_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION nexora_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION nexora_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER stock_movements_no_truncate BEFORE TRUNCATE ON stock_movements
  FOR EACH STATEMENT EXECUTE FUNCTION nexora_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION nexora_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION nexora_reject_mutation();
--> statement-breakpoint

-- 2. Source-of-truth views. party_balances and stock_levels are caches checked against these.
CREATE VIEW v_party_balance AS
SELECT party_type, party_id, sum(debit_paise - credit_paise) AS balance_paise
FROM ledger_entries
GROUP BY party_type, party_id;
--> statement-breakpoint
CREATE VIEW v_stock AS
SELECT product_id, sum(qty_base) AS qty_base
FROM stock_movements
GROUP BY product_id;
--> statement-breakpoint

-- 3. Application role privileges (only when the role exists; see docs/database.md).
-- The app may read and write data but never change journal history or the schema.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexora_app') THEN
    GRANT USAGE ON SCHEMA public TO nexora_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nexora_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nexora_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON ledger_entries, stock_movements, audit_log FROM nexora_app;
  END IF;
END
$$;
