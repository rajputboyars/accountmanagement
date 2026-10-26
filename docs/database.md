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
| `0003_catalog_units.sql` | generated + hand-edited | `units` table (per shop, unique short code), `products.description`, `product_units.is_active`; backfills default units (and any unit already used by a product) for existing shops before adding the `products (shop_id, base_unit) → units (shop_id, code)` foreign key; grants `units` to `nexora_app`. 39 tables in total |
| `0004_pricing_rules.sql` | generated + hand-edited | `price_slabs.shop_id` (backfilled from the product, then NOT NULL) and `is_active`; the slab unique key becomes "one active slab per product and minimum"; customer rules get CHECKs (% between 0.1% and 30%, fixed price needs a product, minimum ≥ 0) and partial unique indexes (one active fixed price per customer/product/minimum, one active % per customer and product, one active % for all products per customer). A database with duplicate active rules or out-of-range % values must be cleaned before applying it |
| `0005_inventory_opening.sql` | generated + hand-edited | Partial unique index: one `opening` stock movement per product. Backfills missing `stock_levels` cache rows from `stock_movements` (existing cache rows untouched). Adds `role_permissions` rows for the new `stock.opening` permission (owner allowed) to existing shops. Fails if a database already has two opening movements for one product |
| `0006_party_balance_cache.sql` | hand-written | Backfills missing `party_balances` cache rows from `ledger_entries` (existing rows untouched). No schema change |
| `0007_credit_note_checks.sql` | generated | Credit notes: total = taxable + CGST + SGST + round off, round off within ±50 paise, non-negative amounts, index on invoice. Credit note lines: one per invoice line per note, non-negative amounts, index on invoice line (for remaining quantities) |
| `0008_purchases_receiving.sql` | generated + hand-edited | Goods receipt lines keep unit, factor, quantity and cost as entered plus GST rate and amount; receipts get a status (received/cancelled) with who/why, a total check (total = value + GST) and indexes; the supplier-bill unique index now ignores cancelled receipts; `suppliers.is_active`; order indexes; `role_permissions` rows for the new `purchases.cancel` (owner) |
| `0009_expenses_cashbook.sql` | generated | Expenses get an optional reference and void details (who, when, why) with checks: category is one of the fixed list, Other needs a note, a voided expense has a reason; date indexes on expenses and cash movements |
| `0010_party_ledgers.sql` | generated + hand-edited | `customers.whatsapp_consent` and `consent_updated_at`; unique receipt numbers per shop and year; `role_permissions` rows for the new `payments.reverse` (owner) |
| `0011_staff_approvals.sql` | hand-added | `role_permissions` rows for `approvals.view` (every role) and `approvals.decide` (owner only); no table changes (the `approvals` table exists since 0001) |
| `0012_onboarding_import.sql` | generated | `import_jobs`: type `opening_stock`, status `committing`, `file_name`, history index, unique committed file per shop and type; `import_rows`: `entity_id` (record created, so retries skip it) and unique row number per job |
| `0013_notifications.sql` | generated + hand-added grants | `notifications` (one row per recipient, unique per user and dedupe key), `notification_preferences` (mutes), `whatsapp_messages` (outbox: status, attempts, next attempt, provider id, unique dedupe key per shop) |
| `0014_business_settings.sql` | generated + hand-added permission rows | `shops`: `gst_registration`, `inter_state_sales`, `gst_rates_bp`, `invoice_prefix`; `invoices`: `tax_mode` (intra/inter/none, with amount checks) and `place_of_supply`; `igst_paise` on invoice lines, credit notes and their lines; `settings.edit` (owner) |
| `0015_settings_numbering.sql` | generated | `number_series.start_value` (numbering has started once `next_value` passes it); product GST rate check widened to the notified rates |
| `0016_purchase_gst_rates.sql` | generated | goods receipt line GST rate check widened to the notified rates (a supplier may charge 3% or 40%) |

## Tables by owning module

| Module | Tables |
| --- | --- |
| settings | shops, devices, number_series, number_blocks |
| identity | users, role_permissions, sessions, otp_requests, approvals |
| parties | customers, suppliers |
| catalog | units, categories, products, product_units, product_cost_history |
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
