@AGENTS.md

# Nexora Business OS

Billing, pricing, stock, dues, purchases and daily closing for one Indian plumbing/building-materials shop (V1). Money and stock correctness beat speed.

## Token budget (read first)

- **Spec rules and golden values: `docs/spec-digest.md`.** Open the claude.ai spec/architecture/prototype docs only when the digest doesn't answer the question, and then read just the section you need (they are ~180 KB).
- **Never read whole long files.** `docs/implementation-handoff.md`, `docs/setup.md`, `docs/database.md`: Grep for the heading, then Read that range. Code files: Grep first, Read with offset/limit.
- **Don't read generated files:** `db/migrations/meta/*`, `.next/`, `node_modules/` (except `node_modules/next/dist/docs` sections), `package-lock.json`.
- **Tests:** run only the touched files (`npx vitest run tests/<area>`), then the full suite once at the end. Pipe long output: `| grep -E "Tests |FAIL|×|Error" | head`.
- **Browser checks:** only when UI changed. Prefer `get_page_text`/`find` over screenshots; use `scale: 0.6` when a screenshot is needed. One width per change unless layout changed.
- **Skills:** load a project skill once per task, not per step. Don't re-load `ui-ux-pro-max` unless asked.
- **Replies:** short. Don't restate code you just wrote, don't re-read files you just edited.

## Sources

`docs/implementation-handoff.md` wins over everything (final decisions, phases §7). Then the Product spec (https://claude.ai/artifact/KAduhdhWmTXX58qEPQbWrC), Technical Architecture (https://claude.ai/artifact/VEgirHZa4tNZYdV86FGiaJ) and UI prototype (https://claude.ai/artifact/2ZgT5smjrDkAJPU9yi8t5d). If a doc can't be opened, say so; never invent its content.

## Stack (locked)

Next.js 16 App Router · React 19 · TS strict · Tailwind 4 · shadcn/ui · PostgreSQL 16 · **Drizzle** (never Prisma) · Zod · own phone-OTP sessions · Vitest + Testcontainers. New dependency only if the handoff lists it; otherwise ask.

Scripts: `dev build start lint typecheck test test:watch secret db:up db:generate db:check db:migrate db:seed db:studio`. `npm test` needs Docker.

## Architecture

- Modules in `src/modules/<name>/`; a module owns its tables; others import only its `index.ts`.
- `src/shared/**` is pure (no Node/DB): money, GST, pricing engine, invoice/credit-note/purchase/cashbook maths.
- Services: `requirePermission` → Zod parse → `withTransaction` (+ `withIdempotency` for writes) → audit row in the same tx.
- Day lock: `src/server/day-lock.ts` for every money write.

## Integrity (non-negotiable)

1. Balance = `SUM(ledger_entries)`, stock = `SUM(stock_movements)`; `party_balances`/`stock_levels` are caches written in the same tx.
2. Journals and `audit_log` are append-only; fix with reversals/credit notes/adjustments.
3. Server recomputes every price, tax, total, balance, cost; client values are only compared.
4. Integer paise, `numeric(14,3)` base-unit quantities, basis points. No floats.
5. Half-up per line and per GST rate group; bill total to the rupee.
6. Lock order: day lock → document → products → `stock_levels` (id order) → `party_balances` → `number_series`.
7. Profit only when every line has a cost.
8. Every query filters by the session's `shop_id`; never trust IDs, roles or prices from the browser.

## Security

Never read/print/commit secrets (`.env*` blocked). No production DB access. Owner-only actions are checked on the server.

## Design

Light default + dark toggle; navy `#14243A`, teal `#0D9488`/`#0F766E`, amber `#F5A623`, page `#F7F9FC`; Inter; shadcn + Tailwind tokens only; one navy panel per screen; ₹ with Indian grouping; design loading/empty/error/denied states; works at 1440/1024/390.

## Workflow

Feature branch per phase (never `master`). Name the spec scenario IDs. Tests first for money/stock/schema. Forward-only migrations. Finish with lint, typecheck, test, build, `db:check`. Stage specific files only; never stage `.claude/skills/ui-ux-pro-max/` or `.env*`. Push/PR/destructive commands only after approval.

Skills: `nexora-frontend` (UI), `nexora-db-review` (schema), `nexora-integrity-review` (money/stock), `nexora-test-review` (before done).
