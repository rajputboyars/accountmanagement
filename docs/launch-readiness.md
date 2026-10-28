# Launch readiness (pilot)

Status as of **28 Oct 2026**, commit `469d585` on `master`. "Verified" means checked on that date with the method given; everything else is a recommendation or an open item.

## Verdict

**Ready for a controlled pilot once the three blockers below are resolved. Not ready for a public launch.** No open critical security or financial-integrity issue was found in the code. The blockers are about how a real shop's installation is set up, not about the app's logic.

## Blockers before the first real shop

1. **Sign-in needs a real SMS provider.** Real shops sign in with an SMS code. The only provider built in is MSG91, which needs a DLT-registered OTP template and charges per SMS. Production refuses the console provider, and the on-screen "demo" provider is allowed only in demo mode. Without MSG91 (or another provider added later), real staff cannot sign in. This is a paid service: the owner decides.
2. **Each shop needs its own production installation.** The live site (`accountmanagement-eta.vercel.app`) is the **public demo**: sample data, sign-in codes shown on screen, anyone can sign in. First-time setup creates one shop per server, so every pilot shop needs its own Vercel project and database without demo settings (`docs/pilot-checklist.md`).
3. **Backups for real data must be switched on and tested** per shop: the database's restore window checked in its console, plus a nightly `pg_dump` if that window is short, and one restore drill (`docs/deployment.md` §4).

## Verified

| Area | What was checked | How |
| --- | --- | --- |
| Deployment | Live demo runs `469d585`; health `ok`, database `ok`, migrations `current` | `GET /api/health` |
| Migrations | Applied during production deploys only (never previews), stop the build if they fail, never print the connection string; all 20 migrations are additive or widen checks | `scripts/migrate-on-deploy.mjs`, migration files, schema test |
| Access without sign-in | Pages and CSV exports redirect to sign-in; cron job and WhatsApp webhook return 403 without the secret/signature | `curl` against the live site |
| Security headers | HSTS, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy; no "powered by" header | `curl -I` against the live site |
| Authentication | Hashed session tokens, new token per sign-in, short sessions for counter staff, deactivated users and changed roles take effect at once; sign-in codes lock after wrong tries with resend limits; owner PIN is Argon2id and locks after 5 tries | automated tests (`tests/identity`) |
| Permissions and shop isolation | Every service checks its permission on the server; another shop's records can't be read or changed; menus show only what each role can open | automated tests (`tests/identity`, `tests/security`, per-module isolation tests, `tests/unit/navigation.test.ts`) |
| Business flows | Sale, part/full payment, change, cancellation, return, receipt and reversal, purchase, supplier payment and reversal, stock moves and adjustments, expenses and voids, drawer, GST (CGST/SGST vs IGST), reports and CSV totals reconcile | automated tests on separate test databases: `tests/accounts`, `tests/sales`, `tests/purchasing`, `tests/inventory`, `tests/cashbook`, `tests/reports`, `tests/settings` |
| Duplicates and failures | Double submissions save once; races for the last stock, a credit limit or the same cancellation resolve to one outcome; a write that fails part-way leaves nothing behind | automated tests, including `tests/accounts/integrity.test.ts` |
| First-time setup and onboarding | Setup, checklist, product, opening stock, first bill, CSV import with errors and the "rows left out" file | browser walkthroughs at 375 px on brand-new local test databases |
| Backup and restore procedure | `pg_dump` → restore into a scratch database → integrity queries return 0 mismatches and row counts match → scratch deleted | run on the local preview database (not on Neon) |
| Error logging | One JSON line per server error with name, Postgres code, digest and route; no messages, queries or customer data in production | `src/instrumentation.ts` |
| Dependencies | 3 low-severity advisories, all in the shadcn command-line tool (not part of the running app); fixing needs a breaking upgrade | `npm audit --omit=dev` |
| Checks | lint, typecheck, full test suite, build, `db:check` pass | local run |

## Not verified (do before or during the pilot)

- **Restore on the managed database** (Neon point-in-time or branch restore): only the `pg_dump`/`pg_restore` procedure was tested, locally.
- **Rollback**: Vercel Instant Rollback was not exercised. Migrations are additive, so rolling the app back is expected to work, but try it once on a pilot installation before relying on it.
- **Real SMS and WhatsApp sending**: no provider is configured; only the WhatsApp share links were tested.
- **Load**: no load or penetration testing.
- **The Vercel plan and its terms** for a commercial pilot (see costs).

## Known limitations (V1, by design)

- One shop per installation. No purchase returns to suppliers (debit notes), no net profit, no festive schemes or retail slabs, no negative stock (see `docs/spec-digest.md`, "Not in V1").
- Prices are entered before GST; there is no tax-inclusive pricing. GST is calculated and printed, but there is **no GST filing, e-invoicing or e-way bill**.
- No shop logo on bills (no file storage).
- Profit shown is gross profit, and only when every sold item has a cost price.
- WhatsApp messages are prepared and opened in the person's own WhatsApp unless a WhatsApp provider is configured; nothing claims delivery.

## Running costs on the current setup

| Item | Current plan | Notes |
| --- | --- | --- |
| Database | Neon **Free** (verified in the Vercel integration: 1 GB storage and 100 compute-hours per project) | Each shop's project is separate; the database sleeps when idle, so the first request after a quiet spell is slower |
| Hosting | Vercel (plan not verified from here) | Vercel's Hobby plan is meant for personal, non-commercial use; a paying business pilot should be on a plan that allows commercial use. Check before onboarding real shops |
| SMS sign-in codes | Not set up | MSG91 charges per SMS and needs DLT registration; get a quote |
| Uptime monitoring | Not set up | Free uptime monitors exist; point one at `/api/health` |
| Off-site nightly backups | Not set up | Needs a scheduler and storage; only needed if the database's own restore window is too short |

## Monitoring and recovery (recommended set-up per shop)

- Uptime monitor on `/api/health` every few minutes; alert after two failures.
- Keep Vercel logs (log drain, if the plan allows) so an error page's reference code can be looked up later.
- Weekly: run the two integrity queries from `docs/deployment.md` §4 on the live database (read-only); both must return 0.
- Rollback and data-recovery steps: `docs/deployment.md` §5. Fix data with the app's own reversals first; restore only into a new database.

## Next actions

1. Owner decides on the SMS provider (MSG91 quote + DLT template) and the Vercel plan for commercial use.
2. Create the first pilot shop's installation (no demo settings), switch on backups and an uptime monitor, and do one restore drill and one rollback there.
3. Onboard the first shop with `docs/pilot-checklist.md`; add the next shop after a clean first week.
