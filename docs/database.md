# Nexora database guide

PostgreSQL 16 + Drizzle ORM. The schema implements the Technical Architecture doc, sections 2–3 (approved V1 schema), and `docs/implementation-handoff.md` §5. The Drizzle files and migrations in this repo are now the local source of truth for the schema.

## First-time setup (local)

```bash
cp .env.example .env          # then choose your own local passwords in .env
npm run db:up                 # PostgreSQL 16 in Docker, bound to 127.0.0.1:5432
npm run db:migrate            # applies db/migrations in order
npm run db:seed               # fictional sample shop (set SEED_ALLOW=true first); safe to repeat
```

`db:up` needs Docker Desktop running. The container's first start runs `db/docker/init/01-app-role.sh`, which creates the two roles below.

## Roles

| Role | Used by | Can |
| --- | --- | --- |
| `nexora_owner` | `drizzle-kit migrate`, `db:seed` (via `DATABASE_MIGRATION_URL`) | Owns the schema; runs DDL |
| `nexora_app` | The Next.js app (via `DATABASE_URL`) | SELECT/INSERT/UPDATE/DELETE on data. **No DDL. No UPDATE, DELETE or TRUNCATE on `ledger_entries`, `stock_movements`, `audit_log`.** |

The journals are also protected by triggers, so even the owner role cannot change history: `UPDATE`, `DELETE` and `TRUNCATE` raise "… is append-only".

## Commands

| Command | What it does |
| --- | --- |
| `npm run db:generate` | Generates a new SQL migration from changes in `src/modules/*/schema.ts` |
| `npx drizzle-kit generate --custom --name=<name>` | Empty migration for hand-written SQL (triggers, views, grants) |
| `npm run db:check` | Checks the migration history is consistent |
| `npm run db:migrate` | Applies pending migrations to the database in `DATABASE_MIGRATION_URL` |
| `npm run db:seed` | Loads the sample shop (development only) |
| `npm run db:studio` | Opens Drizzle Studio to browse local data |
| `npm run typecheck` | TypeScript check, including schema files and the seed |

## Changing the schema safely

1. Edit the owning module's `schema.ts` (see the table below). Never define or query another module's table.
2. `npm run db:generate`, then **read the generated SQL** in `db/migrations/`. Use the `nexora-db-review` skill.
3. Flag destructive steps (DROP, type changes, NOT NULL on existing columns, renames) for approval with a data plan.
4. Apply locally with `npm run db:migrate`; check `npm run db:check`.
5. Never edit a migration after it is merged. Fix forward with a new migration.
6. Never run migrations or the seed against a production or shared database from a developer machine. The seed refuses to run unless `SEED_ALLOW=true`, `NODE_ENV` is not production, and the host is `localhost`.

To inspect what will run, read the pending files in `db/migrations/` and compare with the applied list: `select * from drizzle.__drizzle_migrations;`.

## Migrations

| File | Kind | Contents |
| --- | --- | --- |
| `0000_extensions.sql` | hand-written | `pg_trgm` (product-name search), `pgcrypto` |
| `0001_v1_schema.sql` | generated | 38 tables, keys, foreign keys (no cascades), unique/partial indexes, CHECK constraints |
| `0002_journals_views_privileges.sql` | hand-written | Append-only triggers, `v_party_balance` and `v_stock` views, `nexora_app` grants |

## Tables by owning module

| Module | Tables |
| --- | --- |
| settings | shops, devices, number_series, number_blocks |
| identity | users, role_permissions, sessions, otp_requests, approvals |
| parties | customers, suppliers |
| catalog | categories, products, product_units, product_cost_history |
| pricing | price_slabs, customer_price_rules |
| sales | invoices, invoice_lines, credit_notes, credit_note_lines |
| payments | payments |
| ledger | ledger_entries (journal), party_balances (cache) |
| inventory | stock_movements (journal), stock_levels (cache), stock_adjustments |
| purchasing | purchase_orders, purchase_order_lines, goods_receipts, goods_receipt_lines |
| cashbook | expenses, cash_movements, day_closings |
| audit | audit_log (journal) |
| sync | idempotency_keys |
| imports | import_jobs, import_rows |

Schema files import other modules' `schema.ts` only to declare foreign keys. Services and repositories still use only their own module's tables.

## Data rules built into the schema

- Money is `bigint` paise; quantities `numeric(14,3)` in the base unit; GST and discounts in basis points.
- Balances = `SUM(ledger_entries)`, stock = `SUM(stock_movements)`. `party_balances` and `stock_levels` are caches written in the same transaction and checked against `v_party_balance` / `v_stock`.
- Idempotency: `idempotency_keys` (shop, key); journals have unique `(source_type, source_id, …)` keys so a retried write cannot post twice; payment references are unique while recorded.
- Document numbers are unique per (shop, financial year).

## Sample seed contents

Sharma Sanitary & Hardware (fictional), FY 26-27, go-live 1 Oct 2026: 5 staff users (one per role), default role permissions, 3 counters, number series, 7 categories, 8 products (one deliberately without a cost price), units, wholesale slabs, 6 customers (incl. walk-in) with 3 price rules, 3 suppliers, opening stock as `opening` stock movements, and opening customer/supplier balances as `opening` ledger entries. No sales, payments or purchases are seeded.
