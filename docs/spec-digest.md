# Spec digest (read this instead of the full claude.ai spec)

Short form of the Product & Business Logic Spec and the handoff decisions already built into the code. Section numbers refer to the spec. Open the full spec only for something missing here.

## Roles and permissions

Owner, manager, cashier, inventory (defaults in `src/shared/permissions.ts`). Owner only: edit prices/slabs/customer rules, see cost and profit, cancel bills, close/reopen day, pay suppliers, cancel purchases, opening stock, staff, import.

## Pricing (§3, P1–P3)

Retail list → retail price only. Wholesale list → wholesale price → highest slab reached (base quantity) → customer fixed price if lower → customer % (product beats all-products), half-up to the paisa. Slab: min qty > 1, price ≤ wholesale, below cost needs owner confirmation. Customer % 0.1–30%.

- P1: Mehta, 150 Astral pipes, fixed ₹430 beats slab ₹440 → line ₹64,500.
- P3: 3 boxes of 50 elbows → 150 pc, slab ₹28, box rate ₹1,400, line ₹4,200.

## Billing (§2)

Subtotal → bill discount % (role limit: cashier 3%, manager 7%, owner 100%) → taxable → GST per rate group (CGST = SGST = round(taxable × rate ÷ 2)) → total rounded to the rupee (±₹0.50). Walk-in must pay in full. Credit only within limit (balance + unpaid ≤ limit). Part and split payments allowed. Stock can't go negative.

- Example A (Gupta, wholesale, −1%): subtotal ₹33,264.00 · CGST = SGST ₹2,993.76 · total ₹39,252 · round off +₹0.48. On credit with ₹62,000 owed and ₹1,00,000 limit → blocked. Paying ₹20,000 UPI → dues ₹81,252.
- Example B (2 basins, 2% discount): taxable ₹4,704 · GST ₹846.72 · total ₹5,551 · change from ₹6,000 = ₹449.

## Returns and cancellation (§5, §7, S4, D2)

Credit note: returned quantity × original line's discounted taxable value + GST per rate group, rounded to the rupee; never more than sold − returned. S4: 2 of 60 Example A pipes → ₹900.90 + ₹162.16 → ₹1,063. Saleable → stock up; damaged → received and written off. Cancel bill: owner, same day, before closing, reverses stock/ledger/payments; number kept as CANCELLED.

## Stock (§5, S3)

Adjustments: return (+), damage (−), count fix (±), reason required, never below zero, owner approval above ₹2,000 at cost. Low = at/below reorder level; Reorder now = below half. Opening stock: one OPENING movement per product.

## Purchases (§5, S1, S2, S5)

Order → receive (full or short) → stock up, supplier dues up by received value (+ GST input). Supplier payment > 0 and ≤ owed. Cost = weighted average on each receipt (handoff §2.2).

- S1: receive 500 elbows @ ₹22 + 20 boxes tape @ ₹70 = ₹12,400; Supreme ₹22,800 → ₹35,200; pay ₹10,000 → ₹25,200.
- S2: only 450 elbows → ₹11,300, "Received · short".
- S5: 94 @ ₹402 + 180 @ ₹410 → cost ₹407.26.

## Cash and closing (§6, §7)

Expected cash = opening + cash sales + old dues in cash − cash expenses − cash paid to suppliers (− refunds, ± cash in/out). Opening = last counted cash (shop opening cash before the first close). Difference needs a reason; owner closes; closing locks the day; reopen owner-only with reason. Example: ₹5,000 + ₹11,800 + ₹6,400 − ₹850 − ₹4,000 = ₹18,350; counted ₹18,150 → −₹200. Expense categories: Rent, Salary, Transport, Electricity, Tea & snacks, Other (note).

## Customers and dues (§4)

Balance always from the ledger. Payments apply oldest bill first (ageing). Advance = negative balance, used first on the next bill. Receipts get RCPT numbers (not built yet).

## Numbering

`INV|CN|PO|GRN|ADJ|RCPT/26-27/00001`, per financial year (April), gap-free, ≤ 16 characters, from `number_series` inside the transaction.

## Not in V1

Net profit, festive schemes, retail slabs, return to supplier/debit notes, IGST, negative stock.
