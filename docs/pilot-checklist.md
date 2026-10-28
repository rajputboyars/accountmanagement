# Pilot checklist (3–5 shops, 2–4 weeks each)

Read `docs/launch-readiness.md` first: it lists what must be in place before any real shop uses Nexora.

**One installation per shop.** First-time setup creates exactly one shop per server (V1), so each pilot shop gets its own Vercel project and its own database, with its own environment variables and backups. Never put a real shop on the public demo (sign-in codes are shown on screen there and anyone can sign in).

Run alongside the shop's current method (register or old software) for the first week, then switch. Onboard one shop at a time; start the next only when the previous one has a clean first week.

## Before day 1 — installation (developer, per shop)

- [ ] New Vercel project + database per `docs/deployment.md` §1, **without** `DEMO_MODE`, `DEMO_SEED` or `SEED_ALLOW`; a real SMS provider configured (see launch readiness); `/api/health` is green.
- [ ] First-time setup at `/setup` with the shop's name, state, GSTIN and the owner's mobile; then remove `SETUP_TOKEN`.
- [ ] Backups on (database restore window checked in the console; nightly dump if the plan's window is short) and an uptime monitor on `/api/health`.

## Before day 1 — onboarding (owner + helper, ~2 hours)

- [ ] Owner signs in with the SMS code. The dashboard checklist shows what is left.
- [ ] **Settings → Business details & GST:** legal name, address, PIN code, phone, email, state, GST registration, GSTIN (format checked, not verified with the government), GST rates used. Inter-state sales stay **off** unless the owner/CA confirms they sell to other states.
- [ ] **Settings → Invoice:** prefix and starting number for this financial year (with the CA), UPI id, terms.
- [ ] Owner PIN set. **Staff access:** one account per person with the right role — cashier (billing, customers, collections), inventory (stock, purchases), manager (most things except prices, settings and profit). Each signs in once on their own phone. Nobody shares the owner login.
- [ ] **Settings → Go-live setup:** download the templates, import products, then opening stock, customers with old dues (oldest bill date), suppliers. Fix and re-upload the "rows left out" file until nothing is left. Shops without a spreadsheet add items by hand from the dashboard checklist.
- [ ] Opening cash for the drawer entered.

## Day 1 — data verification (owner)

- [ ] Product count, 10 random prices (retail/wholesale/slabs) and HSN/GST rates match the old list.
- [ ] Stock: count 10 fast-moving items on the shelf; they match the app.
- [ ] Customer dues: the top 10 balances match the old ledger to the rupee; ageing looks right.
- [ ] Supplier balances match.
- [ ] Test bill (retail, wholesale with slab, credit customer, UPI part payment), print it, check GST and totals by hand; cancel it.
- [ ] Test return (credit note), a receipt, an expense, and close the day: expected cash matches the counted cash.

## Daily during the pilot (owner, 5 minutes)

- [ ] Close the day; note any cash difference and its reason.
- [ ] Glance at Notifications (low stock, overdue dues and supplier bills, approvals).
- [ ] Note anything slow, confusing or wrong in the feedback log below.

## Weekly

- [ ] Compare the week's sales, collections and expenses with the shop's own records.
- [ ] Spot-check 5 customer balances and 5 stock counts.
- [ ] Confirm backups ran (developer).

## Support

- One named contact per shop (developer or helper) with a phone number written in the shop. Reply the same day to blockers.
- For an error page, ask for the **reference code** it shows (the digest); it finds the matching log line without anyone sharing data.

## Feedback log (one per shop)

Keep it in a shared sheet or notebook. **Do not write customer names, phone numbers, GSTINs or amounts** — use the bill or receipt number and the screen name instead; the details are in the app if needed.

| Date | Shop | Who (role) | Screen | What happened / what they expected | Bill/receipt no. (if any) | Severity | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | |

**Severity and order of fixing**

1. **Blocker** — wrong money, stock or tax; can't sign in; can't bill. Stop and fix before the shop continues; check the other pilot shops for the same problem.
2. **Annoying** — slow, confusing or extra steps every day. Batched weekly, most-reported first.
3. **Idea** — new features. Collected for after the pilot.

## Exit criteria (per shop)

- [ ] Two weeks with daily closing and no unexplained differences.
- [ ] Owner confirms dues and stock match reality.
- [ ] No open blockers; staff bill without help.
- [ ] Restore drill done once on that shop's backup; owner knows how to reach support.
