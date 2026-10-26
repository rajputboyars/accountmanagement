-- Hand-written. party_balances is a cache of v_party_balance: create the missing rows for parties that
-- already have ledger entries (for example sample opening balances loaded before billing maintained
-- the cache). Existing cache rows are left untouched.
INSERT INTO "party_balances" ("party_type", "party_id", "shop_id", "balance_paise", "last_entry_id")
SELECT "party_type", "party_id", min("shop_id"::text)::uuid, sum("debit_paise" - "credit_paise"), max("id")
FROM "ledger_entries"
WHERE ("party_type", "party_id") NOT IN (SELECT "party_type", "party_id" FROM "party_balances")
GROUP BY "party_type", "party_id";
