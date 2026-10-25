---
name: nexora-integrity-review
description: Check that Nexora code handling money, stock, ledgers, pricing, numbering, approvals, returns, cancellations or day closing keeps the financial and inventory integrity rules. Use before merging any change in the sales, payments, ledger, inventory, purchasing, pricing, cashbook or sync modules, or in src/shared/money.ts, gst.ts or pricing-engine.ts.
---

# Nexora financial and inventory integrity review

Rules come from CLAUDE.md "Financial and inventory integrity" and the Technical Architecture doc sections 4–5 (derivation and transaction rules). Formulas and expected values come from the Product Spec sections 2–7. Check the diff against them; never relax a rule to make code pass.

## Checklist

**Calculation**
- [ ] The server recomputes prices, discounts, GST, totals, balances and costs with `src/shared/*`. Client values are only compared (`expectedTotalPaise`) and never stored.
- [ ] Integer paise throughout. Half-up rounding per line and per GST rate group. Total rounded to the rupee, round off within ±₹0.50.
- [ ] Price order: retail list → retail price; wholesale list → wholesale price → highest slab reached → fixed customer price if lower → customer % off.
- [ ] Slabs and conversions use the base quantity (box × factor).

**Transactions**
- [ ] One `withTransaction` per business action. Side effects (WhatsApp, PDF, jobs) are queued after commit.
- [ ] Lock order: day lock → document → `stock_levels` sorted by product_id (`FOR UPDATE`) → `party_balances` → `number_series`.
- [ ] Online stock check happens after the lock; online sales never drive stock negative.
- [ ] Credit check (balance + unpaid part ≤ limit) runs under the `party_balances` lock; walk-in customers pay in full.
- [ ] Document numbers come from `number_series` inside the transaction, so a rollback leaves no gap.
- [ ] An `Idempotency-Key` is required. Same key and body → stored response; different body → 409. Payment references are unique while recorded.

**Journals**
- [ ] Every stock change writes a `stock_movements` row; every balance change writes a `ledger_entries` row. The cache rows are updated in the same transaction.
- [ ] No UPDATE or DELETE on journals or audit. Cancellations, returns and corrections write reversals (`sale_cancel`, credit note, refund payment, cancel-and-reissue).
- [ ] Credit notes use the original line's discounted taxable value and GST, and never return more than sold minus already returned.
- [ ] Closed days are untouched: a cancellation after closing becomes a credit note, and a closed day's snapshot never changes.

**Profit, permissions and audit**
- [ ] `unit_cost_paise` is copied onto invoice lines at sale time. `cost_complete` is false when any cost is missing, and reports return `reliable: false` with no single profit figure.
- [ ] Each action checks its permission key on the server. Approval-gated actions consume a matching, unexpired, single-use approval.
- [ ] An audit row is written inside the same transaction.

## Golden values (the expected test results)

| Case | Expected |
| --- | --- |
| Spec Example A (Gupta Builders, wholesale, −1%) | subtotal 3326400 · CGST 299376 · SGST 299376 · total 3925200 · round off +48 |
| Spec Example B (2 basins, 2% discount) | taxable 470400 · GST 84672 · total 555100 · change from ₹6,000 = 44900 |
| Gupta balance from seed | 6200000; oldest unpaid INV-2409-0412, 2800000 still due, 45 days on 2026-10-25 |
| Credit check | 6200000 + 3925200 > 10000000 → `CREDIT_LIMIT` |
| Weighted cost | 94 @ 40200 + 180 @ 41000 → 40726 |
| Credit note (2 pipes from Example A) | taxable 90090 + GST 16216 → 106300 |
| Cash drawer | expected 1835000, counted 1815000 → −20000, reason required |

## Output

For each finding: **blocker / should fix / note**, the file and line, the rule broken, and a concrete failure (for example "two counters can both sell the last 3 units"). Then say which golden values and race tests were run and which weren't.
