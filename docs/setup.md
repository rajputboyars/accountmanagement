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

## Inventory & opening stock (Phase 5) rules and limitations

**Screens.** `/inventory/stock` (stock list with status counts, search, category and status filters, recent adjustments), `/inventory/stock/[productId]` (on-hand quantity, full stock history, adjustment form), `/inventory/stock/opening` (multi-line opening stock with a review step).

**Who can do what.** See stock: `inventory.view` (owner, manager, inventory staff). Enter opening stock: the new `stock.opening` permission (owner only by default; spec §8 has the owner enter and review opening entries). Record an adjustment: `stock.adjust` (owner, manager, inventory staff); one worth more than ₹2,000 at cost, or of a product with no cost price, needs the owner (decision 21). Costs in the history: `profit.view`.

**How stock is calculated.** The quantity shown is always `SUM(stock_movements.qty_base)` for the product (the `v_stock` definition, scoped to the shop). `stock_levels` is a cache written only in the same transaction as a movement; the screens compare it with the journal and show **Needs check** (with the journal quantity and a plain explanation) when they disagree, when the cache is missing, or when stock is below zero. "Recalculate from stock entries" (needs `stock.adjust`) rebuilds the cache from the journal and is audited; it never changes stock. A product with no movements is **Not counted yet** (unknown), never zero. Status: at or below the reorder level → Low; below half of it → Reorder now (spec §5).

**Opening stock.** One `opening` movement per product, dated the opening day, in the base unit (quantity × that product's own pack size), with `unit_cost_paise` = the entered cost or the product's current cost (may be unknown). All lines are validated first and saved in one transaction; a product with any existing movement is refused (use a count fix). The product rows are locked (`FOR UPDATE`, sorted) so two submissions can't both open the same product, and a partial unique index enforces one opening per product. Each submission carries an `Idempotency-Key` (`withIdempotency`): a repeat returns the first result, a reused key with different lines is refused.

**Adjustments** (spec S3). Customer return (+), damaged (−), count fix (±); a reason is required; stock can never go below zero (decision 12); each gets a gap-free `ADJ/26-27/00001` number from `number_series`; one movement, the cache update and an audit row in one transaction, idempotent like opening stock. Lock order: product rows → `stock_levels` → `number_series`.

**Limitations**
- **Costing is not decided here.** Opening cost is stored on the movement only; the product's cost price and `product_cost_history` are not changed. Weighted-average cost on receiving (spec decision 2) belongs to purchasing. No stock value or profit is shown.
- **Owner approval flow is not built.** Staff adjustments above ₹2,000 (or of uncosted products) are refused with "ask the owner" instead of requesting an approval.
- **No "lock opening entries" step** (spec §8 checklist). Opening can only ever happen once per product, which gives the same protection per product.
- **Zero opening stock is not recorded** (a movement can't be 0); such products stay "Not counted yet".
- **No day lock yet.** Closing (and its lock) comes later; adjustments are dated today in Asia/Kolkata.
- **Not connected to sales or purchases yet.** Billing must add `sale` movements under the `stock_levels` lock; nothing deducts stock today.
- **No CSV import of opening stock** (spec §8 describes import; it belongs to the import milestone).
- The sidebar's "Preview build. Screens show sample data; nothing is saved yet." notice is now out of date and should be revised separately.

## Sales & billing (Phase 6) rules and limitations

**Screens.** `/billing` (counter: product search, cart with units, customer, price list, bill discount, split payments, live server preview), `/billing/invoices` (bills by number and date), `/billing/invoices/[id]` (tax invoice with GST summary, amount in words, payments, print view, owner cancel).

**Who can do what.** Make bills: `billing.create` (owner, manager, cashier). See bills: `billing.view`. Cancel: `invoice.cancel` (owner only, same business day, decision 20). Bill discount limits: cashier 3%, manager 7%, owner unlimited (decisions 17–19).

**How a bill is worked out** (spec §2): every line is priced by the Smart Pricing engine on the server; line amount = base quantity × base rate (half-up); bill discount = subtotal × % (half-up), spread over lines by largest remainder; GST per rate group, CGST = SGST = round half-up(group taxable × rate ÷ 2); total rounded half-up to the rupee (round-off within ±₹0.50). Intra-state only (IGST always 0). Golden values from spec Examples A and B are tests.

**Saving** writes, in one transaction: invoice + lines (rate, rate reason, cost at sale), one `sale` stock movement per line, one payment row per method, and for a registered customer a ledger debit for the total and a credit per payment, plus the audit row. Lock order: `stock_levels` (product-id order) → `party_balances` → `number_series`. After the locks it re-prices every line and re-checks stock, the credit limit and the role's discount limit. If any rate or the total differs from what the cashier saw, nothing is saved (`PRICE_CHANGED`) and the new bill is returned to confirm. An `Idempotency-Key` per bill makes a repeated submit return the first invoice. Invoice numbers `INV/26-27/00001` come from `number_series` inside the transaction, so a rollback leaves no gap.

**Payments and dues.** Paid now = sum of Cash/UPI/Card/Bank amounts (≤ total); the rest is credit. Walk-in customers must pay in full and have no ledger. Credit is allowed only while dues after the bill stay within the customer's limit; an advance (negative balance) is used first automatically because dues are always `SUM(ledger_entries)`. Cash received is only used to show change and is not stored. Sales, collections and dues are kept separate; profit is not calculated (cost is stored on each line for later, and `cost_complete` records whether every line had one).

**Cancelling** (owner, today only, reason required): the invoice status becomes cancelled (nothing deleted), `sale_cancel` movements return the stock, each payment gets a refund row by the same method (original marked reversed), and the ledger gets a cancellation credit plus a debit per refund, so dues net to zero.

**Limitations**
- No owner-approval flow: bills over the role's discount limit or the credit limit are refused with "ask the owner" instead of requesting a PIN approval.
- No credit notes / returns for older bills, no receipts for later customer payments, no held bills, no WhatsApp/PDF sharing (print view only).
- No day closing yet, so the "day already closed" check and the day lock are not in place.
- Same product twice on one bill is refused (combine the quantities on one line).
- Counter payments carry no receipt number; receipts come with the payments phase. UPI/cheque references are not captured yet.
- IGST (inter-state) is not supported.
- Low-stock warning on the invoice (spec §2) is not shown yet.

## Sales returns & cancellations (Phase 7) rules and assumptions

**Screens.** `/billing/returns` (find a bill by number, credit note history), `/billing/returns/new?invoice=…` (enter returned quantities per line, saleable or damaged, reason, settlement; review; confirm), `/billing/returns/[id]` (printable credit note). The bill page lists its returns and offers "Return items".

**Who can do what.** Returns need `billing.return` (owner, manager). Cancelling a bill stays owner only, same business day (Phase 6).

**Credit note** (spec §5, S4): numbered `CN/26-27/00001` from `number_series`; quantities are in the product's base unit; each line's value is the original line's discounted taxable value × returned ÷ sold (half-up), and the last return of a line takes exactly what is left, so returns never exceed the line; GST per rate group as on the invoice; total rounded to the rupee. Golden value: 2 of 60 Example A pipes → ₹900.90 + ₹162.16 → ₹1,063. The invoice itself is never edited.

**Stock.** Saleable goods: `return_in` (+). Damaged goods: `return_in` (+) then `damage` (−) in the same transaction, so stock is unchanged but the loss is on record (valued at the line's cost at sale).

**Settlement.** Registered customers: reduce dues (ledger `credit_note` credit; may create an advance) or refund by cash/UPI/bank (refund payment row linked to the credit note, plus a ledger debit, so dues are unchanged). Walk-in customers have no ledger and must be refunded.

**Integrity.** One transaction: credit note + lines, stock movements, ledger entries, refund row, audit. Lock order: the invoice row → `stock_levels` → `party_balances` → `number_series`; locking the invoice serialises all returns of a bill, so concurrent returns can't over-return. Remaining quantity is re-checked after the lock; the amount shown on review is compared and a difference refuses the save (`RETURN_CHANGED`). Idempotency key per return. A bill with any credit note can't be cancelled (return the rest instead); a cancelled bill can't be returned against.

**Assumptions (spec silent)**
- Refunds in money are allowed for any credit note, whatever was paid on the bill; for a registered customer the ledger records both the credit and the refund.
- Quantities are returned in the base unit (part of a box is allowed); the bill's rates, discount and GST are always reused, never today's prices.
- Returns have no time limit and no day lock yet (closing is not built).

**Limitations**
- No owner-approval flow, no corrections (edit same-day bill) yet, no WhatsApp/PDF sharing.
- Refund references (UPI UTR, bank reference) are not captured.
- Cancellation refunds go by the original method; partial cancellation is a return.

## Supplier purchases (Phase 8) rules and limitations

**Screens.** `/suppliers` (what you owe in total and per supplier, add a supplier), `/suppliers/[id]` (statement with running balance, payments with reverse, goods received, pay form, edit details), `/purchases` (orders and receipts), `/purchases/new` (purchase order), `/purchases/receive` (direct receipt, or `?order=` against an order), `/purchases/orders/[id]` (ordered vs received vs still expected; close shortfall, cancel), `/purchases/receipts/[id]` (printable goods receipt; cancel).

**Who can do what.** See: `purchases.view` (owner, manager, inventory). Suppliers and orders: `purchases.edit`. Receive goods: `stock.receive`. Pay a supplier or reverse a payment: `suppliers.pay` (owner). Cancel a receipt or order, close a short delivery: the new `purchases.cancel` (owner).

**How it works** (spec §5, S1, S2, S5). An order (PO/26-27/00001) changes nothing in stock or accounts. A goods receipt (GRN/26-27/00001), against an order or direct, writes in one transaction: receipt + lines (unit, factor, quantity and cost as entered, cost per base unit, GST), a `purchase` stock movement per line, the new cost price, a supplier ledger credit for the bill total (value + GST input), the order's new status ("Received · short" while anything is still expected) and the audit row. Receiving more than is still expected on an order is refused. A supplier's bill number can be entered once per supplier (cancelled receipts excepted).

**Cost price.** Handoff §2.2 decision 2 (final for V1): weighted average on each goods receipt, with every change in `product_cost_history`. New cost per base unit = (stock on hand × current cost + received value) ÷ (stock on hand + received base quantity), half-up; S5: 94 at ₹402 + 180 at ₹410 → ₹407.26. When the current cost is unknown or nothing is in stock, the received cost is used (assumption: the spec does not cover it). Old bills keep the cost stored on their lines.

**Payments and dues.** What you owe a supplier = −SUM(debit − credit) on their ledger (purchases credit, payments debit). A payment must be more than 0 and not more than what is owed (spec); cash/UPI/bank/cheque with an optional reference; a UPI/bank/cheque reference can't be used twice. Payments are idempotent and serialised on the supplier's balance row.

**Corrections.** Cancel a receipt (owner, reason): `purchase` movements with a minus sign take the stock out, the ledger gets a `cancellation` debit, the order reopens; refused if the goods were already sold or used. Cancel an order only while nothing was received; close a short order to stop expecting the rest. Reverse a mistaken supplier payment: a matching "in" payment row and ledger credit; the original is marked reversed. Nothing is deleted or edited.

**Lock order.** Order/receipt row → products (id order) → `stock_levels` → `party_balances` → `number_series`.

**Assumptions and limitations**
- GST on a receipt is worked out per rate group from the entered values (no rupee round-off); if the supplier's bill differs by paise it is not adjustable yet. GST defaults to the product's rate and can be changed per line (S1 uses 0% as in the spec example).
- Cancelling a receipt does not recalculate the product's cost price (a weighted average can't be undone exactly); the owner can correct it on the product.
- No return to supplier / debit note (spec: not in V1), no supplier opening-balance entry screen (import milestone), no due-date reminders.
- Receiving into a product with no opening stock makes the purchase its first stock entry, so opening stock can no longer be entered for it: enter opening stock first at go-live.
- Supplier payments get no receipt number (receipt numbers are for customer payments).

## Expenses & daily cashbook (Phase 9) rules and limitations

**Screen.** `/cashbook?date=…` (Cashbook in the menu): cash drawer breakdown, non-cash totals, everything recorded that day with links to bills, returns and suppliers, add an expense, cash in/out, close or reopen the day, recent closings.

**Who can do what.** See the cashbook, record expenses and cash movements, void an expense: `cash.record` (owner, manager). Close the day: `day.close` (owner). Reopen: `day.reopen` (owner).

**Where the numbers come from (nothing is entered twice).** Money in and out is read from the existing payment rows: bills paid at the counter, old dues paid, refunds (cancellations and credit notes), supplier payments and their reversals. Originals and reversals are both counted, so a cancelled cash bill and its refund cancel out. Expenses and cash movements (bank deposit, owner withdrawal, cash put in) are the cashbook's own records. Only cash reaches the drawer; UPI, card, bank and cheque are listed separately, and a credit sale is shown as "added to dues", never as money received. Sales, credit notes and goods received are shown for context. Cash flow is not profit.

**Expected cash** (spec §7): opening + cash on bills + old dues in cash + cash put in + reversed supplier payments − cash refunds − cash paid to suppliers − cash expenses − cash taken out. Spec example ₹5,000 + ₹11,800 + ₹6,400 − ₹850 − ₹4,000 = ₹18,350.

**Opening cash** (handoff C13): the cash counted at the last closed day, moved on by the cash flows of any later days that were never closed; before the first closing it starts from the shop's opening cash. A bank deposit counts on the day it is recorded, which reaches the same expected cash as the spec's "₹18,150 counted − ₹15,000 deposited".

**Expenses.** Fixed categories (handoff C18): Rent, Salary, Transport, Electricity, Tea & snacks, Other (note required). Amount, date (today or earlier, if that day is open), cash/UPI/bank, optional note and reference. A recorded expense is never edited; it can be voided (who, when, why kept) only while its day is open. After closing, record a correction on today's date.

**Closing** (owner): enter the cash counted; the screen shows "Drawer matches", "Cash short" or "Cash extra"; any difference needs a reason (change given short, unrecorded expense, counting mistake, other with a note). Closing saves a snapshot (cash flows, non-cash totals, sales, credit given, credit notes, purchases, expected, counted, difference, reason). Days close in order: a day can't be closed or reopened behind a later closed day. Reopening needs a reason and is logged; the snapshot is redone at the next close.

**The day lock.** First in the lock order. Bills, bill cancellations, returns, goods receipts and their cancellation, supplier payments and their reversal, expenses and cash movements take a shared lock on (shop, day) and are refused once the day is closed ("This day is closed"). Closing takes the exclusive lock, so a bill being saved at the same moment is either in the snapshot or refused, never lost. The lock lives in `src/server/day-lock.ts` so sales and purchasing can use it without importing the cashbook.

**Limitations**
- Stock adjustments and opening stock are not day-locked (they move stock, not money).
- Customer receipts for old dues (the "collections" line) have no screen yet; the cashbook already counts them when they exist.
- Business day = calendar date in Asia/Kolkata; "shop opening to closing" days that cross midnight are not supported.
- No bank reconciliation, no WhatsApp daily report, no expense attachments.
- A cash difference never blocks closing (spec decision); there is no alert above ₹500 yet.

## Party ledgers & outstanding dues (Phase 10)

**Screens.** `/customers` (to collect, overdue, advances, ageing buckets; add customer with optional go-live opening balance), `/customers/[id]` (unpaid bills oldest-first, statement with from/to, receipts, record payment, reminder, details), `/customers/[id]/statement` (print) and `/statement/csv` (download), `/suppliers` (payables and overdue past terms), `/suppliers/[id]/statement` (print, with unpaid bills and due dates).

**Rules.** Balances are always `SUM(ledger_entries)`. Which bills are open and their age are worked out oldest-first when shown (`src/shared/ageing.ts`), never stored; a cancelled bill and its cancellation are left out as a pair. Customer bills are overdue after 30 days (spec §4 assumption); supplier bills after their payment terms. Customer receipts (`payments.record`): RCPT/26-27/00001, cash/UPI/bank/cheque (cheque needs its number), duplicate UPI/bank/cheque references refused, idempotent, day-locked; paying more than owed is kept as an advance (handoff C9). Reversing a receipt (bounce or mistake) is owner-only (`payments.reverse`, new) and adds a matching entry. Cash receipts show in the cashbook as "old dues paid" from the same row (no double count). Opening balance: one OPENING entry dated the oldest unpaid bill (spec §8).

**Reminders.** Only for customers with recorded WhatsApp consent and a phone; the text holds only that customer's own balance and oldest bill. No WhatsApp provider is built: `src/modules/reporting/reminder-provider.ts` is the boundary (`WHATSAPP_PROVIDER` unset → manual Copy / Open WhatsApp). Sharing is audited as `reminder_shared_manually`; nothing claims delivery.

**Limitations.** No automatic reminders or schedules; no SMS/email; statement PDF is the browser's print-to-PDF; customer opening balances are entered one by one (no import yet); receipts are not allocated to specific bills by hand (always oldest-first, per spec).


## Owner dashboard & business reports (Phase 11)

**Screens.** `/dashboard` (real data; Today / Yesterday / 7 days / This month / custom range): billed sales with paid-at-counter, credit, returns and refunds; collected (by method, old dues, reversals); customer and supplier dues today; expenses; net cash movement; gross profit (owner); stock alerts; billed-vs-collected trend; top products; top dues; low stock; expense breakdown; recent activity. Every figure links to its records. `/reports` lists the reports; `/reports/[kind]` (sales, collections, returns, expenses, products, customer-dues, supplier-dues, stock) shows the rows with totals; `/reports/[kind]/csv` exports them.

**Rules.** All aggregation is SQL on the server (`src/modules/reporting/business.ts` orchestrating each module's range queries); nothing is totalled in the browser. Billed sales = issued bill totals; collections = customer payment rows net of receipts reversed by mistake; refunds and supplier payments are separate; cash movement uses the cashbook's own rules (`cashFlowsForRange`); dues come from the ledger via the Phase 10 receivables/payables views. Gross profit (owner, `profit.view`) = taxable value − cost (unit cost copied at sale × quantity, half-up per line), less credit notes (their taxable value, plus back the cost of restocked goods). If any line in the period has no cost, profit is "Profit unavailable" with the reason and items; no estimate is shown (handoff §1.7, C4). Managers see everything except profit; cashier and inventory roles can't open reports. Custom ranges are at most 366 days and can't end in the future. CSV cells are quoted and formula-safe (`src/shared/csv.ts`; also applied to the Phase 10 statement CSV); amounts in rupees with integer maths; 200 rows on screen, 5,000 in CSV, with a note when cut.

**Limitations.** Dues and stock cards are "as of today", not as of the range end. Receivables/payables reuse the per-party ledger views (one statement query per party), fine for one shop but not for thousands of parties. No sales-by-staff or stock-value report; no charts library (simple CSS bars). The old demo dashboard files under `src/components/dashboard` and `src/demo` are now unused and were left in place (deleting needs approval).

## Staff controls & approvals (Phase 12)

**Screens.** `/settings` (owner): change a staff member's role, sign them out of every device, switch them off (both sign them out at once). `/approvals`: staff ask the owner (what for, which customer/product/bill, the % or amount, reason); the owner sees requester, reason, amount or %, record, time and time left, and approves or rejects (reason required to reject). The dashboard shows the owner a banner when requests are waiting.

**Rules.** Permissions stay the one table in `src/shared/permissions.ts` + `role_permissions`; two keys added: `approvals.view` (all roles, own requests; owner sees all) and `approvals.decide` (owner). Approval rules are the handoff §2.3 list, unchanged: discount above the role limit, credit above the customer's limit, a manager correcting a bill, a stock adjustment above ₹2,000 at cost (or with no cost price). A request is only allowed for an action the asker may do; the owner never asks. Duplicates (same person, action and record, still pending) return the existing request. Approvals expire 10 minutes after the request, are single use, and can't be decided by the person who asked. When the requester saves the bill/adjustment/correction again, the service uses their matching approval inside the same transaction (row locked, re-checked, marked used, audited `identity.approval_used`): same person, same record, and only up to the approved discount %, dues or value. A rollback leaves it unused; two saves racing for one approval → one wins. The owner PIN on the spot remains the other route. Bill correction (`correctInvoice`: cancel + reissue linked by `corrects_invoice_id`, same day, no credit notes) is idempotent and takes locks in the standard order.

**Notifications.** No SMS/WhatsApp provider exists for staff alerts, so alerts are in-app (inbox + dashboard banner); `src/modules/identity/notifications.ts` is the place to add one and never reports delivery it didn't make.

**Limitations.** Below-cost slabs and reopening a day stay owner-only screens (no request flow). The billing and stock screens don't yet show "approval available"; the user just saves again after approval. Bill correction has a service and tests but no screen yet. Approval thresholds are the handoff's (₹2,000; role discount limits 3%/7%); no new financial thresholds were invented. Request lists show the newest 50.

## Go-live setup & data import (Phase 13)

**Screens.** `/settings/setup` (owner, `import.run`): go-live checklist worked out from real records (shop details, owner PIN, staff, products, opening stock, customers, suppliers, first bill), CSV upload, templates, exports and import history. `/settings/setup/imports/[id]`: column mapping, row-by-row preview (ready / skipped / error with reason), commit, and a CSV of the rows left out.

**Rules.** Products, customers (with go-live dues), suppliers and opening stock. Files up to 900 KB (server-action limit) and 2,000 rows; RFC 4180 CSV, inch marks like 1" allowed in plain fields. Rows are checked with the owning module's own Zod schema plus duplicate checks in the file and against the shop (SKU; customer phone, or name when no phone; supplier name; products that already have stock). Nothing is saved until commit; commit re-checks rows and saves each through the normal service (createProduct, createCustomer, createSupplier, recordOpeningStock in idempotent chunks of 200), so stock movements, ledger entries and audit rows are the same as by hand. Each row stores the record it created, so a retry skips it; one commit per shop and type runs at a time (advisory lock; a stuck one can be resumed after 15 minutes); the same file can't be committed twice. Besides `import.run` the owner needs each module's own permission. Exports (products, customers with balance, suppliers with amount owed) use the viewing permissions, show cost only with `profit.view`, and are formula-safe.

**Limitations.** Imports only add new records; existing ones are skipped, never updated. No Excel (.xlsx) upload (save as CSV). Opening stock is dated the import day. A row failing inside a 200-row opening-stock chunk leaves that chunk unsaved with the reason; fix and re-upload.

## Notifications & WhatsApp (Phase 14)

**In-app.** Bell in the header (unread count) and `/notifications` (mark read, mute kinds per person). Alerts: approval requested (owner) and decided (requester), low/out of stock (daily summary to `inventory.view`), overdue customer dues (weekly summary to `customers.edit`), WhatsApp failures (`customers.edit`). Stock and dues summaries are worked out from stock movements and the ledger when the dashboard or notifications page opens; a unique (recipient, dedupe key) makes repeats no-ops. Recipients are active staff of the same shop holding the permission.

**WhatsApp.** `WHATSAPP_PROVIDER=meta` uses the WhatsApp Business Cloud API (`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, optional approved `WHATSAPP_TEMPLATE_NAME` with one body variable); empty keeps manual Copy / Open WhatsApp. "Send via WhatsApp" on a customer queues today's dues reminder in the outbox (consent, phone and balance required; one per customer per day; audited) and sends right after the response. `POST /api/jobs/whatsapp` with `Bearer $CRON_SECRET` sends due messages for all shops (run every minute). Temporary failures (network, 429, 5xx) retry after 1, 4, 16, 64 minutes, up to 5 attempts; permanent failures, withdrawn consent or a changed phone fail the message and alert. A send interrupted mid-way is failed as "outcome unknown", never repeated. Rows are claimed with SKIP LOCKED. Delivered/read come only from `/api/webhooks/whatsapp`, verified with `WHATSAPP_APP_SECRET` (and `WHATSAPP_VERIFY_TOKEN` for the subscription check); statuses only move forward. Tests use a fake provider; nothing reaches the network.

**Limitations.** No scheduler is bundled (call the job route from cron or a platform scheduler). Only dues reminders are sent by WhatsApp; staff alerts are in-app only. No SMS/email. Bulk overdue reminders exist as a service (`queueOverdueReminders`) without a screen yet.

## Business settings & GST (Phase 15)

**Screens.** `/settings` (owner, new `settings.edit`): business details (name, legal name, address, phone, state), GST (registration, GSTIN, inter-state sales, rates used on products) and invoice settings (prefix, starting number, UPI id, bank details, terms). Others see a read-only summary. Bills and credit notes print these saved details.

**GST rules (src/shared/gst.ts), never guessed.** Not registered or composition scheme → "Bill of Supply", no GST (composition bills carry the CGST Rules 5(1) declaration). Regular → "Tax Invoice": CGST + SGST (UTGST for Chandigarh, Ladakh, Lakshadweep, A&N, DNH-DD) when the place of supply is the shop's state, IGST at the full rate when another state. Place of supply defaults to the shop's state (counter sale); another state is used only when chosen on the bill and only if the owner turned on inter-state sales (handoff B2 is open, so off by default); otherwise the bill is refused, not taxed as local. Each bill stores its tax mode and place of supply; credit notes follow the original bill. GSTINs are checked for format, state code and the mod-36 check digit, and must match the shop's state. Product rates must be one of the shop's enabled rates (subset of 0, 0.1, 0.25, 1.5, 3, 5, 12, 18, 28, 40%); the right rate per product still comes from its HSN code.

**Numbering.** Invoice numbers are `PREFIX/26-27/00001` (prefix 1–4 letters, ≤ 16 characters). Prefix and starting number can change only before the financial year's first bill (one consecutive series per year); terms, UPI and bank details can change any time. All changes are audited with before/after.

**Limitations.** No e-invoicing (IRN/QR) or e-way bills; no reverse charge, cess, export/SEZ or exempt-vs-nil distinctions; composition rates and returns are outside the app. Changing registration type mid-year is allowed but should follow the CA's advice; issued bills never change.

## Final QA & security (Phase 16)

**Checked.** Every server action and route handler validates the session (login/setup excepted; webhook and job routes use signature/secret). Services check permissions and filter by the session's shop; cross-shop writes on bills, returns, receipts, expenses, supplier payments, goods receipts and adjustments are refused (`tests/security/hardening.test.ts`). Money writes take the day lock and are idempotent or state-guarded; a duplicate submission replays, a different body with the same key is 409; a failed bill uses no number. After a mixed flow every `party_balances`/`stock_levels` cache equals its journal. Sessions: httpOnly, SameSite=Lax, Secure in production; expired, revoked and switched-off users are rejected; OTP limited to 5 requests/hour and 5 attempts. No secrets are tracked (only `.env.example` placeholders); env validation refuses weak secrets and the console SMS provider in production. Unexpected errors show a generic message; server details stay in logs.

**Fixed.** Purchases refused notified GST rates other than the old five (3%, 40%…), in validation, the form and the database check (migration 0016). Added error, global-error and 404 pages; HSTS in production; shop filter on the expense void lock; the go-live checklist requires the GSTIN for a regular GST shop; the Settings GST form no longer scrolls sideways on phones.

**Not done (known).** No Content-Security-Policy (the inline theme script would need nonces); no external rate limiter beyond OTP limits; no automated browser (e2e) tests yet.

## Deployment & pilot (Phase 17)

- **Runbook:** `docs/deployment.md` covers Vercel (Mumbai) with managed PostgreSQL 16, environment variables, migrate-before-serve (`npm run build:deploy` → `scripts/migrate-on-deploy.mjs`, production only), health check, logging, backups, restore drill and rollback.
- **Pilot:** `docs/pilot-checklist.md` covers onboarding, day-1 data verification, daily and weekly checks, the feedback log and exit criteria.
- **Health:** `GET /api/health` returns 200 or 503 with database and migration state; no session needed.
- **Errors:** `src/instrumentation.ts` writes one JSON line per server error, without customer data.
- **Sign-in in production:** `SMS_PROVIDER=msg91` with `MSG91_AUTH_KEY` and `MSG91_TEMPLATE_ID` (a DLT-approved template); the environment is validated at start.

