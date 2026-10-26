# Nexora developer setup

How to run Nexora locally, sign in, and run the checks. For database details see [database.md](database.md); for decisions and phases see [implementation-handoff.md](implementation-handoff.md).

## Prerequisites

- Node.js 24 and npm
- Docker Desktop (running) — for the local database and the automated tests
- Git

## 1. Install and configure

```bash
npm ci
cp .env.example .env
```

Fill in `.env`. Generate each secret with:

```bash
npm run secret
```

It prints a random 43-character value. Use separate values for `POSTGRES_PASSWORD`, `NEXORA_APP_PASSWORD`, `OTP_PEPPER` and `SETUP_TOKEN`, and put the two database passwords into `DATABASE_URL` and `DATABASE_MIGRATION_URL`.

| Variable | Required | Rules |
| --- | --- | --- |
| `DATABASE_URL` | Yes | `postgres://…`; the app connects as `nexora_app` |
| `DATABASE_MIGRATION_URL` | For migrate/seed | Schema owner (`nexora_owner`); falls back to `DATABASE_URL` |
| `DATABASE_POOL_MAX` | No | 1–50, default 10 |
| `OTP_PEPPER` | Yes | At least 32 characters |
| `SETUP_TOKEN` | Only for first-run setup | At least 32 characters; empty = `/setup` disabled |
| `SMS_PROVIDER` | No | `console` (default, development only) or `msg91` (placeholder) |
| `SESSION_COOKIE_NAME` | No | Lowercase letters and `_`, default `nx_session` |
| `SEED_ALLOW` | Only for `db:seed` | Must be `true` to load the sample shop |
| `POSTGRES_PASSWORD`, `NEXORA_APP_PASSWORD` | For `db:up` | Read by `docker-compose.yml` |

Invalid or missing values stop the server with a message naming the variable (validated in `src/server/env.ts`). `.env` is git-ignored; never commit it.

## 2. Start PostgreSQL and apply migrations

```bash
npm run db:up
```

```bash
npm run db:migrate
```

`db:up` starts PostgreSQL 16 in Docker, reachable only from this machine (127.0.0.1:5432), and creates the `nexora_owner` and `nexora_app` roles on first start.

## 3. Create your shop (choose one)

**A. First-run setup (an empty database).** Set `SETUP_TOKEN` in `.env`, start the app (`npm run dev`), and open http://localhost:3000. You are sent to `/setup`. Enter the shop name, state, optional GSTIN, the owner's name and mobile number, and the setup token. Setup runs once: after a shop exists, `/setup` shows "not found" for good. Remove `SETUP_TOKEN` from `.env` afterwards.

**B. Sample shop (development only).** Set `SEED_ALLOW=true` and run:

```bash
npm run db:seed
```

It loads the fictional "Sharma Sanitary & Hardware" with five staff accounts (owner `9000000001`, manager `9000000002`, cashiers `9000000003` and `9000000004`, inventory `9000000005`), products and opening balances. Because it creates a shop, `/setup` is no longer available on that database.

## 4. Sign in (development OTP)

Open http://localhost:3000/login, enter a staff mobile number and press **Send code**. With `SMS_PROVIDER=console` no SMS is sent: the code is printed in the terminal running `npm run dev`, like this:

```text
[nexora dev OTP] code for ••••••0001: 482913 (valid 5 minutes)
```

Codes last 5 minutes and allow 5 attempts. You can request a new one every 30 seconds, up to 5 per hour per number. Unknown numbers get the same on-screen message but no code.

**The console provider is for development only.** It refuses to run when `NODE_ENV=production`, and environment validation rejects `SMS_PROVIDER=console` in production.

Each role lands on its own page: owner and manager on the Dashboard, cashiers on Billing, inventory staff on Inventory. The owner adds staff and sets the approval PIN in **Settings**.

## 5. Run the app

```bash
npm run dev
```

Only one `next dev` can run per project folder; stop any other dev server first.

## 6. Checks

| Command | What it does |
| --- | --- |
| `npm test` | All automated tests (Vitest + Testcontainers). Needs Docker running. |
| `npm run test:watch` | Tests in watch mode |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript (`tsc --noEmit`) |
| `npm run build` | Production build |
| `npm run db:check` | Migration history consistency |

### How the test database works

`npm test` never touches your `.env` database. It starts a disposable PostgreSQL 16 container with random credentials, creates the same two roles, applies the real migrations to a template database, and gives every test file its own copy. Tests connect as the restricted `nexora_app` role, so they run with production-like permissions. Each file's database is dropped when it finishes, and the container is removed at the end of the run (Testcontainers also cleans up if a run is interrupted). Test secrets are random per run and never written to disk.

## 7. Cleaning up the local database

```bash
docker compose stop db
```

Stops the database and keeps your data.

```bash
docker compose down
```

Removes the container but keeps the data volume.

`docker compose down -v` also **deletes all local data** (the `nexora-db` volume). Use it only when you mean to start from scratch, then run `db:up` and `db:migrate` again. None of these commands affect any other database. Never point `DATABASE_URL` or `DATABASE_MIGRATION_URL` at production from a developer machine.

## 8. Production requirements (before any deployment)

- `NODE_ENV=production`, served over HTTPS (the session cookie is `Secure` and named `__Host-nx_session`).
- `DATABASE_URL` for a `nexora_app`-style role without DDL rights; migrations run separately as the owner role.
- A unique `OTP_PEPPER` of at least 32 random characters, kept in the host's secret store.
- `SETUP_TOKEN` set only for the first setup, then removed.
- A real SMS provider. **Not available yet:** `SMS_PROVIDER=msg91` is a placeholder that refuses to send. Production sign-in needs an Indian DLT-registered SMS integration implementing the `OtpSender` interface in `src/modules/identity/otp-provider.ts`, with its own credentials added then.
- The security items in "Known limitations" below resolved.

## Known limitations (authentication milestone)

| Limitation | Effect | Planned for |
| --- | --- | --- |
| No per-IP rate limiting | OTP limits are per phone number only; one IP can try many numbers | Hardening phase, before production |
| No Content-Security-Policy | Only baseline headers are set (X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy) | Hardening phase, before production |
| One phone number in several shops | Sign-in stops with "belongs to more than one shop"; there is no shop picker | When multi-business support is added |
| `/setup` after setup returns HTTP 200 | The page streams a "not found" screen, but the status code is 200 because of partial prerendering. The setup form is never served again, and setup is also refused on the server | Revisit with route-level handling |
| Sidebar is not role-aware | Every role sees every menu item. Opening a restricted page shows "You don't have access", and the server refuses the data and actions | UI polish when the modules are built |
| MSG91 is a placeholder | No working production SMS delivery | Before production |

## Catalog (Phase 4A) decisions and limitations

- **Who can do what.** Viewing products and units uses `inventory.view` (owner, manager, inventory staff). Adding or changing products, pack sizes and units uses `pricing.edit` (owner only by default), because a product carries its retail and wholesale list prices. Cost prices are shown and saved only with `profit.view` (owner). Cashiers do not see the catalog screens yet; billing will read products through the sales module.
- **Pack sizes are per product.** "1 Box = 50 pc" is stored on the product (`product_units.factor`, numeric(12,3)); there is no shop-wide factor. A size must be more than 0, not exactly 1, at most 3 decimals, and a whole number when the base unit can't be split (Piece, Box, Bag, Set …).
- **Nothing is deleted.** Products, units and pack sizes are switched off and can be switched back on; every change writes an audit row in the same transaction.
- **Base unit lock.** The base unit can't change once a product has pack sizes. Stock movements and invoice lines will also need to lock it; that check is added with those modules.
- **No brand field.** The schema has no brand column; include the brand in the product name or category.
- **Out of scope here.** Quantity slabs, customer prices, opening stock, reorder levels and stock levels are not editable yet.

## Smart Pricing (Phase 4B) rules and limitations

**Who can do what.** `/pricing` and every slab or customer-rule change need `pricing.edit` (owner only by default). A price quote is read-only and is allowed with `billing.create` or `pricing.edit`; costs, margins and the below-cost flag need `profit.view`.

**How a price is chosen** (spec §3, implemented once in `src/shared/pricing-engine.ts`):

1. Price list: chosen by hand, otherwise from the customer type (wholesale customer → wholesale; walk-in, retail or no customer → retail).
2. Retail list → the retail price. Slabs and customer rules never apply.
3. Wholesale list → the wholesale price, then the active slab with the highest minimum that the **base quantity** reaches (a slab at 100 applies from exactly 100).
4. The customer's active fixed price for this product with the highest reached minimum, used only if it is lower than the current rate.
5. The customer's % off: a rule for this product beats a rule for all products. Rounded half-up to the paisa. At most one fixed and one % rule apply; they never stack further.
6. Line amount = base quantity × base rate, rounded half-up to the paisa (so 3 boxes of 50 cost the same as 150 pieces). The box rate shown is base rate × factor, rounded half-up.

Ties that the database already prevents (two active slabs or rules for the same scope) are still broken in a fixed order: highest minimum, then lowest price, then id.

**Checks when saving.** Slab minimum more than 1 base unit (whole for units that can't be split); slab price above 0 and not above the wholesale price; any slab or fixed price below cost needs the owner to tick "I confirm" (recorded in the audit row). Customer % between 0.1% and 30%. Rules are retired, never deleted.

**Limitations**
- No effective dates: the spec has none ("price changes apply to new bills only"). A rule applies from when it is saved until it is retired.
- No separate price per pack unit: a box is always base price × factor (the spec's "unless the owner sets a separate price" is not built).
- A slab saved below the wholesale price stays in force if the wholesale price is later lowered beneath it; the slab is still used (spec order) and the screen does not yet warn about it.
- The quote does not take a transaction yet. Billing must call the engine inside its own transaction and reject a client total that differs; the preview working does not make billing safe.
- Server actions here (as in the catalog) do not send an `Idempotency-Key`; duplicate adds are blocked by unique indexes.
- There is no `/api/v1/pricing/quote` route yet; the price check uses a server action. The route comes with billing.
- The sidebar shows Smart Pricing to every role; other roles get "You don't have access" and the server refuses the data.

