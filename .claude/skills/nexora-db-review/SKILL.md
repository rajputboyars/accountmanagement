---
name: nexora-db-review
description: Review or write Nexora Drizzle schema, SQL migrations and seed data against the approved schema conventions, module ownership and safety rules. Use whenever a change touches src/modules/*/schema.ts, db/migrations, db/seed or drizzle.config.ts.
---

# Nexora database schema and migration review

The reference schema is in the Technical Architecture doc, section 2–3; the migration and seed strategy is in `docs/implementation-handoff.md` §5. Compare against those; don't redesign.

## Checklist

**Conventions**
- [ ] Every business table has `shop_id uuid not null` referencing `shops`, and the repository filters by it.
- [ ] Primary keys are UUID v7 (`uuid`). Journals use `bigint generated always as identity`.
- [ ] Money is `bigint` paise named `*_paise`; quantities are `numeric(14,3)`; rates and percentages are integer basis points (`*_bp`). No `real`, `double` or `float`.
- [ ] Status and type columns are `text` with a `CHECK (... in (...))` list, matching the architecture's values.
- [ ] Every table has `created_at timestamptz not null default now()`.

**Integrity**
- [ ] Foreign keys on every reference. `on delete` stays at the default (restrict); no cascades on money or stock data.
- [ ] Indexes from the architecture are present: unique document numbers per (shop, fy); partial uniques for barcode, payment reference, one owner and one walk-in per shop; lookup indexes (customer/date, product, trigram on name).
- [ ] `ledger_entries`, `stock_movements` and `audit_log` have the append-only trigger (hand-written SQL migration).
- [ ] CHECK constraints are kept: invoice total = taxable + taxes + round off; round off within ±50 paise; `paid_now` ≤ total; debit XOR credit; non-zero quantities.
- [ ] `v_party_balance` and `v_stock` views exist and match the cache tables' meaning.

**Ownership**
- [ ] The table is defined in the `schema.ts` of the module that owns it (architecture section 1). No module defines or queries another module's table.

**Migrations**
- [ ] Generated with `npm run db:generate`, and the SQL was read, not just accepted.
- [ ] No merged migration was edited; changes come as a new numbered file.
- [ ] Destructive steps (DROP, column type changes, NOT NULL on existing data, renames) are flagged to the user with a data plan, and run only after approval.
- [ ] Works on an empty database (`npm run db:reset`) and on top of the previous migration.
- [ ] The app role has no DDL, no TRUNCATE, and no UPDATE/DELETE on the journals. Migrations use `DATABASE_MIGRATION_URL`.

**Seed data**
- [ ] Only the golden sample shop. Opening stock and balances are written as `opening` journal entries, not as cache values.
- [ ] Refuses to run when `NODE_ENV=production` or when `SEED_ALLOW` is not `true`.

## Safety

- Run migrations only against local Docker or Testcontainers. Never connect to a production or shared database from this environment.
- Never read `.env` files. Ask the user for non-secret values when needed.

## Output

List each finding as **blocker / should fix / note**, with the file, line and the convention it breaks. End with what you ran (for example `db:reset` passed) and what you didn't.
