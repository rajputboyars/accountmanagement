---
name: nexora-test-review
description: Finish a Nexora feature properly - map it to spec scenarios, add the right unit/integration/concurrency/e2e tests, run the checks, review the diff, and report honestly. Use before saying a feature, module or milestone is done, or when asked to test or review Nexora code.
---

# Nexora feature testing and code review

The test strategy is in the Technical Architecture doc section 8. Scenario IDs (B1–A1) are in the Product Spec section 10. The Milestone 1 definition of done is in `docs/implementation-handoff.md` §10.

## 1. Map scope

List the spec scenario IDs and architecture edge cases the change covers, and any it should cover but doesn't.

## 2. Choose the right tests

| Change touches | Required tests |
| --- | --- |
| `src/shared` (money, GST, pricing engine, schemas) | Vitest unit tests with golden values, plus fast-check property tests for totals and rounding |
| A module service or repository | Integration test against real PostgreSQL (Testcontainers): rows, journals, caches, audit, rollback on failure |
| Stock, credit, numbering, payments, closing | Concurrency test with parallel connections (last units, credit race, 50 parallel numbers, duplicate tap, close vs bill) |
| A route handler | Contract test: status codes, error shape, 403 for each role without the permission, 404 for another shop's IDs |
| A user flow or screen | Playwright at 1440, 1024 and 390 px for the matching flow (A–D) once e2e is set up |

Use the golden fixture (`db/seed/sample-shop.ts`); never invent different sample numbers. Money and stock tests are written before or with the code, not after.

## 3. Run the checks

Run only the scripts that exist in `package.json`, in this order: `npm run lint` → `npm run typecheck` → `npm run test` → `npm run test:integration` → `npm run build` (or `npm run check` once it exists). Integration tests need Docker; if Docker isn't available, say so and don't mark those tests as passed.

## 4. Review the diff

- Read the full diff (`git diff master...HEAD`).
- Apply `nexora-integrity-review` if money, stock or ledger code changed, and `nexora-db-review` if schema or migrations changed.
- Check:
  - module boundaries (no cross-module `repo`/`schema` imports)
  - thin route handlers
  - Zod at the edge
  - no secrets or `.env` contents
  - no new dependency outside the handoff
  - no TODOs left in money paths
- For a broader pass, run the built-in `/code-review` skill if it's available in the session. Treat its findings as input and verify each one.

## 5. Report

- What changed, with the scenario IDs now passing.
- The exact commands run and their results. Quote failures and don't hide them.
- What wasn't verified and why (no Docker, no browser, scenario not yet implemented).
- Remaining risks or follow-ups.

Never call a feature done while a required test is missing or failing.
