# Nexora V1 — Implementation Handoff

Status: approved for build · Date: 26 Oct 2026 · Scope: V1, one plumbing/building-materials shop

This is the final brief for developers. It locks the decisions from three source documents and says how to start building. Where this file and an older document disagree, this file wins.

| Source | What it defines |
| --- | --- |
| Nexora Business OS (interactive prototype artifact) | Screens, workflows, copy, visual direction |
| Nexora V1 Product & Business Logic Spec (doc) | Business rules, formulas, 31 test scenarios (B1–A1), 30 business decisions |
| Nexora V1 Technical Architecture (doc) | 15 modules, PostgreSQL schema, transaction rules, API, security, testing, phases |

No application code has been written for these modules yet. The repo has a Create Next App starter with Tailwind v4, shadcn/ui, Motion and GSAP. Its hero page in `src/app/page.tsx` will be replaced by the app shell in Milestone 1.

---

## 1. Non-negotiable principles

1. **Modular monolith.** One Next.js app and one PostgreSQL database. There are 15 modules, and each owns its own tables. No microservices.
2. **The ledger is the source of truth.**
   - Customer and supplier balances are the sum of `ledger_entries`.
   - Stock is the sum of `stock_movements`.
   - Both tables, plus `audit_log`, are append-only and enforced by a database trigger.
   - `party_balances` and `stock_levels` are caches, updated in the same transaction and reconciled every night.
3. **Server-side money.** The server recomputes every rate, discount, tax, total, balance and cost. The client's `expectedTotalPaise` is only compared; it is never stored.
4. **Idempotent writes.** Every write needs an `Idempotency-Key`. For bills and payments the key is the record's own UUID v7, generated on the device.
5. **Transactional stock.** Bills lock `stock_levels` rows with `FOR UPDATE`, sorted by `product_id`. Online sales can never drive stock negative.
6. **Auditable reversals.** Cancellations, returns and corrections write new reversing rows. Money and stock rows are never edited in place.
7. **Reliable profit only.** If any line in a period has no cost price, the reports API returns `reliable: false`. It never returns a single profit number in that case.

---

## 2. Final decisions

### 2.1 Conflicts between documents, resolved

| # | Topic | Prototype | Spec / architecture | Final decision |
| --- | --- | --- | --- | --- |
| C1 | Visual direction | Light default with dark toggle; navy · teal · amber; Inter; soft-blue option | Brief palette, Inter | Follow the interactive prototype: light by default, a dark toggle, the navy/teal/amber palette and Inter. Soft blue stays an optional palette. Use the Home v2 canvas board only for layout reference (icon rail, rounded cards, navy feature panel). |
| C2 | Roles | Owner, Manager, Cashier, Inventory | Brief named 3 roles; spec added Manager | 4 roles. Manager is optional; the owner simply doesn't assign it. |
| C3 | Permission table | Display-only | Enforced on the server | Enforced on every API route (§2.3). The owner can edit it; changes are audited. |
| C4 | Profit with missing cost | "≈ ₹9,180 Estimated" headline | "Profit not available" | Use the spec rule. The headline shows "Profit not available · cost missing for N items". A secondary line may show profit on fully costed bills. |
| C5 | Invoice numbering | `INV-2410-0483`; prefix setting has no effect | `INV/26-27/00483`, per financial year, ≤16 characters | Use the spec format. Numbers come from `number_series`, are gap-free and restart each financial year (April). The prefix is editable but validated so the full number stays ≤16 characters. |
| C6 | GST | 18% on every item | HSN code and rate per product; tax per rate group | Per product (0/5/12/18/28%). CGST = SGST = round(taxable at that rate × rate ÷ 2), calculated per invoice. The invoice header is authoritative. |
| C7 | "Prices include GST" setting | Exists, has no effect | Exclusive pricing | V1 is GST-exclusive only. Remove the setting until the business confirms otherwise (B5). |
| C8 | Counter payment | Fully paid or fully credit | Part and split payment | Part and split payment ship in V1, with one `payments` row per method. |
| C9 | Overpayment | Rejected | Advances recommended | Accept it as an advance (a negative customer balance), used first on the next bill. Needs business confirmation (B3). |
| C10 | Customer return | Stock adjustment only | Credit note | A credit note against the invoice. It credits the ledger or records a refund, and restocks the item or logs it as damaged. |
| C11 | Import of an existing SKU | Overwrites cost, prices and stock | Prices only | Prices and details only. Stock changes only when the owner ticks "Replace stock", which records a count-fix movement per product. |
| C12 | Closing permission | A manager can press Close | Owner only | Owner only, enforced on the server. |
| C13 | Opening cash | Fixed ₹5,000 | Previous counted cash minus withdrawals | Previous day's counted cash minus bank deposits and withdrawals (`cash_movements`). The first day uses `shops.opening_cash_paise`. |
| C14 | Week / Month / Custom figures | Sample constants | Real data | Calculated from real records for any date range. |
| C15 | Slab below cost | Blocked | Owner approval | Allowed only with an owner approval (`approvals.action = 'below_cost'`). |
| C16 | Units | One unit plus a conversion note | Base unit and conversion factors | Stock is kept in the base unit, and `product_units` holds the factors. Slabs are checked against the base quantity. |
| C17 | Bill correction | Not built | Cancel and reissue (T4) | Cancel and reissue under a new number, in one transaction, linked by `corrects_invoice_id`. |
| C18 | Expenses | Sample data only | Expense screen | Expenses ship in V1 with categories: Rent, Salary, Transport, Electricity, Tea & snacks, Other (with a note). |
| C19 | Settings route | `#preferences` (an artifact URL limit) | `/settings` | The app uses `/settings`. |

### 2.2 Open decisions resolved with defaults

These are final for V1 unless the business overrides them later.

| Spec / tech # | Decision | Final |
| --- | --- | --- |
| 2 | Cost method | Weighted average on each goods receipt; history kept in `product_cost_history` |
| 9 | Cheques | Counted when received. A bounce creates a reversal entry and alerts the owner; no automatic charge. |
| 10 | Credit limit override | Allowed for one bill with owner approval |
| 11 | Interest on overdue dues | None |
| 12 | Negative stock | Blocked online. Offline sync may create it, flagged as `sync_conflict`. |
| 13 | Bill discount on top of slab/customer price | Allowed, capped by the role limit |
| 14–16 | Retail slabs / when fixed price beats slab / festive schemes | No retail slabs / the lower price wins / festive schemes deferred to V2 |
| 17–19 | Manager role / limits per role / cashier sees customer balance | Yes / per role (Cashier 3%, Manager 7%, Owner unlimited) / yes |
| 20 | Who cancels bills | Owner only, same business day, before closing. Afterwards, a credit note. |
| 22 | Large cash difference | Doesn't block closing; reason required; owner alerted if above ₹500 |
| 23 | Net profit | Not in V1; gross profit only |
| 25–26 | Inventory staff see costs / batch tracking | Only on the receiving screen / no batch tracking |
| 27–28 | Offline credit / offline limit | Up to the last known available credit / 24 hours or 200 bills per device |
| 29–30 | `.xlsx` import / past bills | Accept `.xlsx` and `.csv` / opening balances only |
| — | Rounding | Half-up to paise per line and per tax group; total rounded to the rupee, round-off within ±₹0.50 |
| — | Overdue threshold | 30 days, as a shop setting |
| — | Business day / timezone | Asia/Kolkata. Bills after closing belong to the next business day. |
| — | UPI/cheque reference | Required for cheques and for UPI over ₹2,000; must be unique while recorded |
| T1 | Hosting | Vercel (Node runtime) plus managed PostgreSQL 16 in the Mumbai region, and S3-compatible storage in India |
| T2 | ORM | Drizzle (approved; do not switch to Prisma) |
| T3 | SMS / OTP | A provider interface. `console` in development; an Indian DLT-registered provider (MSG91) in production |
| T4 | Bill correction | Cancel and reissue |
| T5 | Quantity precision | `numeric(14,3)` in the base unit |
| T6 / T7 | Jobs / offline storage | pg-boss / Dexie, each built in its own phase (§6) |
| — | Audit retention | 8 years; deletion jobs are disabled |

### 2.3 Permission keys and default roles

| Permission | Owner | Manager | Cashier | Inventory |
| --- | --- | --- | --- | --- |
| `billing.create`, `billing.view` | ✓ | ✓ | ✓ | — |
| `billing.return` (credit notes) | ✓ | ✓ | — | — |
| `invoice.edit` (correction) | ✓ | approval | — | — |
| `invoice.cancel` | ✓ | — | — | — |
| `pricing.edit` | ✓ | — | — | — |
| `customers.view`, `payments.record`, `payments.view` | ✓ | ✓ | ✓ | — |
| `customers.edit` | ✓ | ✓ | — | — |
| `inventory.view`, `purchases.view` | ✓ | ✓ | — | ✓ |
| `purchases.edit`, `stock.receive`, `stock.adjust` | ✓ | ✓ | — | ✓ |
| `suppliers.pay` | ✓ | — | — | — |
| `reports.view` | ✓ | ✓ | — | — |
| `profit.view` | ✓ | — | — | — |
| `cash.record` | ✓ | ✓ | — | — |
| `day.close`, `day.reopen`, `staff.manage`, `audit.view`, `import.run` | ✓ | — | — | — |

Approval rules (owner PIN or owner phone; single use; expires after 10 minutes):
- a discount above the role limit
- a rate below cost after discount
- credit beyond the customer's limit
- a manager correcting a bill
- a stock adjustment worth more than ₹2,000 at cost
- reopening a closed day

### 2.4 Needs business or legal confirmation before go-live

Build with the default; get these confirmed by the owner or the shop's CA.

| # | Question | Default used | Who confirms |
| --- | --- | --- | --- |
| B1 | Is turnover below the GST e-invoicing (IRN) threshold? | No e-invoicing in V1 | CA (legal) |
| B2 | Any inter-state sales (IGST)? | None; IGST columns exist but are unused | Owner |
| B3 | Accept customer advances? | Yes | Owner |
| B4 | Shop GSTIN, legal name, state code (08 Rajasthan) | Sample values in the seed only | Owner |
| B5 | Do prices include GST? | No (exclusive) | Owner / CA |
| B6 | Audit and record retention period | 8 years | CA (legal) |
| B7 | SMS sender ID and DLT template registration | Console OTP until approved | Owner (registration is in the business's name) |
| B8 | Customer phone numbers: consent and privacy notice under India's DPDP Act | Notice on the receipt; no marketing use | Legal |
| B9 | Thresholds: ₹2,000 stock adjustment, ₹500 cash difference, 30-day overdue | As stated | Owner |
| B10 | Invoice prefix and starting number for FY 26-27 | `INV/26-27/00001` | Owner / CA |

---

## 3. Technology stack and versions

| Layer | Choice | Version rule |
| --- | --- | --- |
| Runtime | Node.js 24 LTS | `.nvmrc` = 24; `engines.node` = `>=24 <25` |
| Framework | Next.js App Router, React | Already in repo: `next 16.4.3`, `react 19.3.0`. Keep pinned exactly. |
| Language | TypeScript, `strict: true` plus `noUncheckedIndexedAccess` | 5.x |
| UI | Tailwind CSS 4, shadcn/ui (base-nova), lucide-react, Motion (small UI motion), GSAP (scroll and complex animation only) | Already in repo |
| Database | PostgreSQL 16 with extensions `pg_trgm` and `pgcrypto` | Same major version locally (Docker), in CI and in production |
| ORM | Drizzle ORM + drizzle-kit with the `pg` driver | Install the latest stable in Milestone 1 and pin exactly |
| Validation | Zod, shared by browser and server | Latest stable major, pinned |
| Auth | Our own sessions: database sessions, phone OTP, Argon2id for the owner PIN | `@node-rs/argon2` |
| IDs | UUID v7 | `uuid` package |
| Jobs | pg-boss | Added in Phase 8 / Phase 11 |
| Offline | Dexie on IndexedDB, plus a service worker | Added in Phase 10 |
| Testing | Vitest, fast-check, Testcontainers (PostgreSQL), Playwright | Added in Milestone 1 |

Version policy:
- **Pinning:** pin exact versions (no `^`) for next, react, drizzle-orm, drizzle-kit, zod, pg and playwright. Commit `package-lock.json` and use `npm ci` in CI.
- **Upgrades:** one dependency-update pull request per month. Majors only on purpose, with the full test suite.
- **Node types:** fix `@types/node` to the Node 24 line; the repo currently has `^20`.

---

## 4. Folder structure

This adapts the architecture's layout to the repo's existing `src/` directory and `@/*` import alias.

```text
accountmanagement/
├─ docs/                         # implementation-handoff.md + links to the spec and architecture docs
├─ db/
│  ├─ migrations/                # generated + hand-written SQL, numbered, never edited after merge
│  └─ seed/
│     ├─ sample-shop.ts          # golden fixture (Sharma Sanitary & Hardware) — dev/test only
│     └─ permissions.ts          # default role_permissions (§2.3)
├─ src/
│  ├─ app/
│  │  ├─ (auth)/login/           # OTP sign-in
│  │  ├─ (auth)/setup/           # first-run shop + owner setup (only when no shop exists)
│  │  ├─ (app)/layout.tsx        # icon rail, top bar, sync pill, theme toggle
│  │  ├─ (app)/page.tsx          # owner dashboard (Home)
│  │  ├─ (app)/billing/  inventory/  pricing/  customers/  purchases/
│  │  ├─ (app)/reports/  staff/  settings/
│  │  ├─ (mobile)/m/             # owner phone view
│  │  └─ api/v1/…                # thin route handlers, one folder per endpoint
│  ├─ modules/                   # 15 modules, same shape each:
│  │  └─ <module>/  index.ts (public API) · service.ts · repo.ts · schema.ts (Drizzle tables) · errors.ts · *.test.ts
│  │     identity · settings · catalog · pricing · parties · sales · payments · ledger
│  │     inventory · purchasing · cashbook · reporting · imports · sync · audit
│  ├─ shared/                    # no Node/DB imports — runs in browser and server
│  │  ├─ money.ts  gst.ts  pricing-engine.ts  permissions.ts
│  │  └─ schemas/                # Zod request/response schemas
│  ├─ server/                    # db.ts (pool, withTransaction, locks) · auth.ts · http.ts · jobs.ts · env.ts
│  ├─ client/                    # api.ts (typed fetch + Idempotency-Key) · offline/ (Phase 10)
│  ├─ components/
│  │  ├─ ui/                     # shadcn/ui (exists)
│  │  └─ nexora/                 # KPI card, money cell, status pill, collection dial, sync pill
│  └─ lib/                       # existing utils.ts, gsap.ts
├─ tests/
│  ├─ integration/  concurrency/  e2e/
├─ drizzle.config.ts
├─ docker-compose.yml            # local PostgreSQL 16
└─ .env.example
```

Boundary rules, enforced by an ESLint import-restriction rule:
- **Between modules:** code outside a module may import only that module's `index.ts`. `repo.ts` and `schema.ts` are private to the module.
- **From the app:** `src/app/**` may import modules' `index.ts`, `src/shared` and `src/components`. It never imports `src/server/db` directly.
- **Shared code:** `src/shared/**` must not import `pg`, `drizzle-orm`, `next/server` or anything in `src/server`.
- **Transactions:** services accept an optional `tx`, and route handlers open transactions only through `withTransaction`.

---

## 5. Database migrations and seed data

**Migrations**
1. Drizzle table definitions live in each module's `schema.ts`, and `drizzle.config.ts` collects them.
2. `npm run db:generate` creates SQL in `db/migrations/`. A person reads the generated SQL in every pull request.
3. Some objects Drizzle can't express go in hand-written SQL migrations in the same folder:
   - extensions (`pg_trgm`, `pgcrypto`)
   - append-only triggers on `ledger_entries`, `stock_movements` and `audit_log`
   - partial unique indexes (barcode, payment reference, one owner per shop, one walk-in customer per shop)
   - the `v_party_balance` and `v_stock` views
   - check constraints, wherever Drizzle's output differs from the architecture
4. `npm run db:migrate` applies migrations locally, in CI and when deploying. `drizzle-kit push` is allowed only against a throwaway local database.
5. A merged migration is never edited; fixes go in a new migration. The production deploy runs migrations before the new code starts serving.
6. The application database role can only read and write data: no DDL, no TRUNCATE, and no UPDATE or DELETE on the three journals. Migrations run under a separate role.
7. Milestone 1 creates the full V1 schema from the architecture (all tables, keys, indexes and constraints, including `invoices.corrects_invoice_id`). That lets later modules be built in parallel without schema churn.

**Seed data**
- `npm run db:seed` loads `db/seed/sample-shop.ts`, the golden fixture from the spec:
  - products: Astral pipe, Supreme elbow, Ashirvad valve and the rest
  - customers: Gupta Builders (₹62,000), Mehta, Shree Ram, Verma, Anil, walk-in
  - suppliers, slabs and customer rules
  - opening stock and balances as `opening` journal entries
- It refuses to run when `NODE_ENV=production` or when `SEED_ALLOW` is not `true`.
- Tests load the same fixture, so expected values such as ₹39,252, ₹62,000 and ₹18,350 match everywhere.
- Real go-live data comes in through the import module (Phase 9), never through the seed.

---

## 6. Authentication and business-account setup

1. **First run.** If no shop exists, `/setup` asks for the shop name, GSTIN, state, financial-year start, opening cash, and the owner's name and mobile. It is protected by a one-time `SETUP_TOKEN` from the environment. It creates `shops`, the owner `users` row, the default `role_permissions` and the `number_series` rows for the current financial year. After the first shop exists, `/setup` returns 404.
2. **Sign-in.**
   - The user enters their mobile number and gets a 6-digit OTP, valid for 5 minutes, with 5 attempts. OTPs are stored as an HMAC using `OTP_PEPPER`, and rate limits apply.
   - In development the `console` SMS provider prints the OTP to the server log.
   - The session is a random 256-bit token in an httpOnly, Secure, SameSite=Lax cookie; the database stores only its SHA-256 hash.
   - Counter sessions last 12 hours; the owner's phone stays signed in for 30 days.
3. **Owner PIN.** Set at the owner's first sign-in and hashed with Argon2id. Five wrong attempts lock approvals for 15 minutes and alert the owner.
4. **Staff.** The owner adds staff (name, mobile, role) in Staff & Permissions. Staff sign in with their own number; shared logins aren't supported.
5. **Devices.** A counter is named on first sign-in (Counter 1, Counter 2, Wholesale desk), creating a `devices` row. Offline number blocks are tied to the device (Phase 10).
6. **Every request** runs `getSession`, then `requirePermission(key)`, then Zod parsing. Repositories always filter by `shop_id = session.shopId`.

---

## 7. Module implementation order

| Phase | Modules | Depends on | Output |
| --- | --- | --- | --- |
| **0 — Milestone 1** | settings, identity, audit, plus the full schema and seed | — | Platform foundation (§10) |
| 1 | catalog, pricing (`shared/pricing-engine.ts`, `/pricing/quote`) | 0 | Smart Pricing screen; spec P1–P3 |
| 2 | parties, ledger | 0 | Customers and suppliers; statements with ageing |
| 3 | inventory | 1 | Stock journal, adjustments, Inventory screen; S3 |
| 4 | sales (invoices) and the counter part of payments | 1, 2, 3 | Billing screen; B1–B10 and race tests |
| 5 | payments (receipts, advances) | 2, 4 | C1–C3; duplicate references refused |
| 6 | purchasing | 2, 3 | S1, S2, S5; weighted-average cost |
| 7 | sales (credit notes, cancel, correct) plus approval flows | 4, 5 | S4, D2 |
| 8 | cashbook, reporting, plus pg-boss for owner alerts | 4–7 | Home, Reports and Closing screens; R1, R2, D1 |
| 9 | imports | 1, 2, 3 | I1, I2; go-live checklist |
| 10 | sync, plus Dexie, the service worker and number blocks | 4, 5 | O1, O2; mobile owner view |
| 11 | Hardening: reconciliation job, backups, rate limits, error tracking, full end-to-end suite | all | Release gate |

Phases 1–3 can run in parallel after Milestone 1. Phases 5 and 6 can also run side by side.

---

## 8. Environment variables

`.env.example` (no real values; `src/server/env.ts` validates these with Zod at startup and refuses to boot if any are missing):

```bash
# App
NODE_ENV=development
APP_URL=http://localhost:3000
TZ=Asia/Kolkata
SETUP_TOKEN=change-me-one-time-setup-token

# Database
DATABASE_URL=postgres://nexora_app:password@localhost:5432/nexora
DATABASE_MIGRATION_URL=postgres://nexora_owner:password@localhost:5432/nexora
DATABASE_POOL_MAX=10

# Auth
OTP_PEPPER=generate-32-random-bytes-base64
SESSION_COOKIE_NAME=nx_session
SMS_PROVIDER=console            # console | msg91
SMS_API_KEY=
SMS_SENDER_ID=
SMS_DLT_TEMPLATE_ID=

# Storage (invoice PDFs, imports, exports)
S3_ENDPOINT=
S3_REGION=ap-south-1
S3_BUCKET=nexora-dev
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=

# Jobs / observability (later phases)
JOBS_ENABLED=false
ERROR_TRACKING_DSN=

# Dev only
SEED_ALLOW=true
```

---

## 9. Commands

Today the repo has only `dev`, `build`, `start` and `lint`. Milestone 1 adds the rest.

| Command | Purpose |
| --- | --- |
| `docker compose up -d db` | Start local PostgreSQL 16 |
| `npm ci` | Install exactly what the lockfile says |
| `npm run db:generate` | Generate SQL migrations from Drizzle schemas |
| `npm run db:migrate` | Apply migrations |
| `npm run db:seed` | Load the golden fixture (dev/test only) |
| `npm run db:reset` | Drop, migrate and seed the local database |
| `npm run dev` | Next.js dev server |
| `npm run lint` | ESLint, including the module boundary rules |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Vitest unit and property tests |
| `npm run test:integration` | Vitest against PostgreSQL via Testcontainers (needs Docker) |
| `npm run test:e2e` | Playwright at 1440, 1024 and 390 px |
| `npm run check` | lint + typecheck + test + test:integration (CI gate) |
| `npm run build` | Production build |

CI runs on every pull request: `npm ci`, then `npm run check`, then `npm run build`, then migrations against a fresh database. The end-to-end suite runs before each release.

---

## 10. Definition of done: Milestone 1 (Phase 0, foundation)

**Database**
- [ ] Docker Compose PostgreSQL 16; `db:migrate` creates the full V1 schema from the architecture on an empty database with no errors.
- [ ] Integration test: UPDATE and DELETE on `ledger_entries`, `stock_movements` and `audit_log` are rejected.
- [ ] Integration test: the invoice total CHECK constraint, the partial unique indexes and `one_owner_per_shop` behave as specified.
- [ ] `db:seed` loads the sample shop; `v_party_balance` shows Gupta Builders at 6200000 paise and `v_stock` matches the seeded opening stock.

**Platform code**
- [ ] `src/shared/money.ts` and `gst.ts` pass unit tests using spec Example A: subtotal 3326400, GST 598752 (CGST 299376 + SGST 299376), total 3925200, round off +48. Also Example B: total 555100.
- [ ] `withTransaction`, lock helpers, the idempotency middleware and the error-shape mapper exist and are tested. A repeated idempotency key returns the stored response; the same key with a different body returns 409 `IDEMPOTENCY_CONFLICT`.
- [ ] `env.ts` refuses to start when a required variable is missing.

**Auth and permissions**
- [ ] `/setup` creates the shop and owner once, then returns 404.
- [ ] OTP sign-in works with the console provider; sessions are stored hashed; sign-out revokes the session.
- [ ] The owner sets a PIN; five wrong PINs lock approvals.
- [ ] Default permissions from §2.3 are seeded. An integration test proves a cashier gets 403 on an owner-only endpoint, and the refused attempt is audited.
- [ ] Every write in Milestone 1 (setup, sign-in, PIN set, staff add, permission change) creates an `audit_log` row inside the same transaction.

**UI shell (matches the prototype artifact)**
- [ ] The hero page is replaced by the `(app)` layout:
  - icon rail with the ten destinations
  - top bar with page title, sync pill (static "All synced") and "Viewing as" role display
  - theme toggle that starts in light mode and remembers the choice
  - Inter font, navy/teal/amber tokens
- [ ] Login and Staff screens work; other destinations show a "Coming in phase N" empty state, not a broken page.
- [ ] Renders correctly at 1440, 1024 and 390 px (the bottom bar replaces the rail on phones), in light and dark mode, with no horizontal scroll.

**Quality gate**
- [ ] `npm run check` and `npm run build` pass locally and in CI.
- [ ] Module boundary lint rule active; no imports of another module's `repo.ts` or `schema.ts`.
- [ ] `docs/implementation-handoff.md` and `.env.example` are committed; README explains how to start the project in under 10 minutes.
- [ ] The decisions in §2.4 are logged as open items with owners assigned.
