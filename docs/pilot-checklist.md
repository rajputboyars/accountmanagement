# Pilot checklist (one shop, 2–4 weeks)

Run alongside the shop's current method (register or old software) for the first week, then switch.

## Before day 1 — onboarding (owner + helper, ~2 hours)

- [ ] Deployment done per `docs/deployment.md`; `/api/health` is green; owner signs in with an SMS code.
- [ ] **Settings → Business details & GST:** legal name, address, phone, state, GST registration, GSTIN (checked), GST rates used; inter-state sales stay **off** unless the owner/CA confirms they sell to other states (handoff B2).
- [ ] **Settings → Invoice:** prefix and starting number for this financial year (handoff B10, with the CA), UPI id, terms.
- [ ] Owner PIN set; staff added with the right roles (cashier, manager, inventory); each signs in once.
- [ ] **Go-live setup:** import products (template CSV), then opening stock, customers with old dues (oldest bill date), suppliers. Fix and re-upload the "rows left out" file until nothing is left.
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
- [ ] Glance at Notifications (low stock, overdue dues, approvals).
- [ ] Note anything slow, confusing or wrong in the feedback log below.

## Weekly

- [ ] Compare the week's sales, collections and expenses with the shop's own records.
- [ ] Spot-check 5 customer balances and 5 stock counts.
- [ ] Confirm the nightly backup ran (developer).

## Feedback log

| Date | Who | Screen | What happened / what they expected | Severity (blocker / annoying / idea) | Status |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

**Blocker** = wrong money, stock or tax, can't sign in, can't bill: fix before continuing. Everything else is batched weekly.

## Exit criteria (end of pilot)

- [ ] Two weeks with daily closing and no unexplained differences.
- [ ] Owner confirms dues and stock match reality.
- [ ] No open blockers; staff bill without help.
- [ ] Restore drill done once; owner knows how to reach support.
