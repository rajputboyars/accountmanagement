@AGENTS.md

# Nexora Business OS

Billing, pricing, stock, customer dues, purchases and daily closing for one Indian plumbing/building-materials shop (V1). Money and stock correctness matter more than speed of delivery.

## Source of truth

- `docs/implementation-handoff.md` — **final decisions, stack, folder structure, phases, Milestone 1 definition of done.** Read the relevant section before starting any task. It wins over every other document.
- Product & Business Logic Spec (Claude Doc): https://claude.ai/artifact/KAduhdhWmTXX58qEPQbWrC — rules, formulas, test scenarios B1–A1.
- Technical Architecture (Claude Doc): https://claude.ai/artifact/VEgirHZa4tNZYdV86FGiaJ — schema, transaction rules, API, testing.
- UI prototype (artifact): https://claude.ai/artifact/2ZgT5smjrDkAJPU9yi8t5d — screens, workflows, copy.

The three links are private claude.ai documents. They may not be readable in every session; if you can't open one, use the handoff and say so. Never invent details from a document you couldn't read.

## Stack (locked — do not change or add alternatives)

Next.js App Router (16.x, pinned) · React 19 · TypeScript strict · Tailwind CSS 4 · shadcn/ui · PostgreSQL 16 · **Drizzle ORM** (never Prisma) · Zod · own DB sessions with phone OTP · pg-boss (Phase 8+) · Dexie offline (Phase 10 only) · Vitest, Testcontainers, Playwright.

Before adding any dependency, check that the handoff lists it. Otherwise, ask first.

## Commands

The repo currently has `npm run dev | build | start | lint`. Milestone 1 adds `typecheck`, `test`, `test:integration`, `test:e2e`, `check`, `db:generate | db:migrate | db:seed | db:reset` (see handoff §9). Use only scripts that exist in `package.json`.

## Architecture rules

- Modular monolith: one app, one database, 15 modules in `src/modules/<name>/` (identity, settings, catalog, pricing, parties, sales, payments, ledger, inventory, purchasing, cashbook, reporting, imports, sync, audit).
- A module owns its tables. Other code imports only `src/modules/<name>/index.ts`, never its `repo.ts` or `schema.ts`.
- Route handlers (`src/app/api/v1/**`) are thin: session → `requirePermission` → Zod parse → one service call → error mapping.
- `src/shared/**` (money, GST, pricing engine, Zod schemas) has no Node or DB imports; browser and server run the same code.
- Cross-module work in one transaction passes the same `tx` into each module's public service function.

## Financial and inventory integrity (non-negotiable)

1. Balances are `SUM(ledger_entries)` and stock is `SUM(stock_movements)`. `party_balances` and `stock_levels` are caches, updated in the same transaction.
2. Journals and `audit_log` are append-only. Fix mistakes with reversals, credit notes and adjustments, never UPDATE or DELETE.
3. The server recomputes every price, discount, tax, total, balance and cost. Client totals are only compared.
4. Money is integer paise (`bigint`); quantities are `numeric(14,3)` in the base unit; rates and discounts are basis points. No floats.
5. Rounding is half-up per line and per GST rate group; the bill total rounds to the rupee.
6. Every write is idempotent (`Idempotency-Key`), runs in one transaction, and writes its audit row inside that transaction.
7. Lock order: day lock → document → `stock_levels` (sorted by product_id) → `party_balances` → `number_series`.
8. Profit is reported only when every line has a cost (`reliable: false` otherwise). Never show an estimated profit figure as profit.

Use the `nexora-integrity-review` skill on any change touching money, stock, ledger, numbering or approvals.

## Security

- Never read, print or commit real secrets. `.env*` files are blocked for Claude; only `.env.example` (placeholders) is committed.
- No production database access from this environment. Migrations and seeds run against local Docker or Testcontainers only. The seed refuses to run in production.
- Every query filters by `shop_id` from the session; IDs in the request body are never trusted.
- Owner-only actions (cancel, close, reopen, permissions, import, supplier payments) are checked on the server, not only hidden in the UI.

## Design system

- Follow the UI prototype: light mode by default with a dark toggle; navy `#14243A` · teal `#0D9488` (`#0F766E` for text and filled buttons) · amber `#F5A623` · page `#F7F9FC`; Inter; white rounded cards; icon rail on desktop and tablet, bottom bar on phones; one navy feature panel per screen.
- shadcn/ui components and Tailwind tokens only; no ad-hoc colours. Motion for small UI motion, GSAP only for scroll or complex sequences; respect `prefers-reduced-motion`.
- ₹ amounts use Indian grouping (₹1,00,000) and tabular numbers. Every screen designs its loading, empty, error, offline and access-denied states.
- Check at 1440, 1024 and 390 px, in light and dark mode. Use the `nexora-frontend` skill for UI work.

## Workflow

1. Work in the phase order from handoff §7, one module or screen at a time, on a feature branch (never commit to `master`).
2. Start by naming the spec scenario IDs (for example B2, C1) the change must satisfy.
3. Money, stock and schema code: write or extend tests first, then implement.
4. Schema changes: `nexora-db-review` before merging. A merged migration is never edited.
5. Finish with `nexora-test-review`: run the checks, map results to scenario IDs, review the diff.
6. Commit small and descriptive. Push, open pull requests or run destructive commands (drop, reset, force-push, deleting files) only after the user approves.

## Project skills

| Skill | Use when |
| --- | --- |
| `nexora-frontend` | Building or changing any screen or component |
| `nexora-db-review` | Adding or reviewing Drizzle schema, migrations or seed data |
| `nexora-integrity-review` | Any change to billing, payments, ledger, stock, pricing, numbering, approvals or closing |
| `nexora-test-review` | Before calling a feature done: tests, verification, code review |
| `ui-ux-pro-max` | Extra UI/UX reference data (palettes, UX guidelines); project rules above win |
