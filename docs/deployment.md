# Deployment, backups and rollback

Hosting (handoff T1): **Vercel** (Node runtime, region `bom1` Mumbai) and **managed PostgreSQL 16** in Mumbai (`ap-south-1`). Nothing here deploys by itself: every step below is run by the owner or their developer, with their own accounts and billing.

## 1. One-time setup

**Database (managed PostgreSQL 16, Mumbai)**

1. Create the instance with automated backups and **point-in-time recovery (at least 7 days)**, encryption at rest, TLS required, and no public access other than from Vercel (allow-list or private networking).
2. Create two roles, as `db/docker/init/01-app-role.sh` does locally:
   - `nexora_owner` owns the schema and runs migrations (used only at deploy time).
   - `nexora_app` is what the app connects as: read/write data, no DDL. Migration 0002 also stops it from changing journal history.
3. Enable the extensions `pg_trgm` and `pgcrypto` (handoff §3).
4. Use connection strings with `?sslmode=require`.

**Vercel project**

1. Import the Git repository. `vercel.json` sets the Mumbai region and the build command `npm run build:deploy`.
2. Add **Production** environment variables (Project → Settings → Environment Variables). Values never go in Git or chat:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` (Vercel sets it) |
| `DATABASE_URL` | `nexora_app` connection string, `sslmode=require` |
| `DATABASE_MIGRATION_URL` | `nexora_owner` connection string (Production only; used by the build to migrate) |
| `DATABASE_POOL_MAX` | `5` (serverless functions each open a small pool) |
| `OTP_PEPPER` | `npm run secret` (32+ characters; changing it invalidates pending codes only) |
| `SESSION_COOKIE_NAME` | `nx_session` (sent as `__Host-nx_session` in production) |
| `SMS_PROVIDER` | `msg91` (the console provider is refused in production) |
| `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID` | from MSG91; the template must be DLT-approved, with the code variable named as `MSG91_OTP_VARIABLE` (default `otp`) |
| `SETUP_TOKEN` | `npm run secret`, only until the shop is set up; then delete it (setup closes) |
| `WHATSAPP_*`, `CRON_SECRET` | optional, see `.env.example`; leave empty to keep manual WhatsApp sharing |
| `SEED_ALLOW` | leave unset (the seed refuses production anyway) |

   **Preview** deployments get their own throwaway database (or none). Never give a Preview the production URLs.
3. First deploy, then open `/setup` with the `SETUP_TOKEN` to create the shop and owner. Remove `SETUP_TOKEN` and redeploy.

## 2. Every deploy

1. Merge to the production branch. Vercel runs `npm run build:deploy`:
   - `scripts/migrate-on-deploy.mjs` applies pending migrations with `DATABASE_MIGRATION_URL`, but only for a production deploy (`VERCEL_ENV=production`). If migrations fail, the build stops and the current version keeps serving.
   - `next build` builds the app.
2. Traffic switches to the new build only after a successful build.
3. Migrations are **forward-only and backward-compatible** (add columns/tables, widen checks); the previous build must keep working on the new schema for a few minutes. Never drop or rename a column in the same release that stops using it.
4. Check `GET /api/health`: `200 {"status":"ok","database":"ok","migrations":"current"}`; `503` means the database is unreachable or migrations are behind.
5. Smoke test on the live site with the owner: sign in (SMS code arrives), make a ₹1 test bill and cancel it, open Reports.

## 3. Monitoring and error logging

- **Uptime:** point an uptime monitor at `/api/health` every minute; alert on two failures.
- **Errors:** `src/instrumentation.ts` writes one JSON line per server error (`event: "request_error"`, digest, error name, Postgres code, route; no messages, no customer data). Add a Vercel Log Drain to keep logs beyond Vercel's retention. A digest shown to staff on the error page finds the matching log line.
- **WhatsApp job (optional):** Vercel Cron, `GET /api/jobs/whatsapp` every 5 minutes. Sub-daily crons need a paid Vercel plan; confirm with the owner before adding a `crons` entry.

## 4. Backups

| What | How | Keep |
| --- | --- | --- |
| Point-in-time recovery | Managed database setting | 7–35 days |
| Nightly logical backup | `pg_dump --format=custom --no-owner "$DATABASE_MIGRATION_URL" > nexora-YYYY-MM-DD.dump`, uploaded to encrypted S3-compatible storage in India (`ap-south-1`) | 30 daily + 12 monthly |
| Before every risky change | A manual snapshot in the database console | until verified |

**Monthly restore drill** (never against production):

1. Create a scratch database and restore: `pg_restore --no-owner --dbname "$SCRATCH_URL" nexora-YYYY-MM-DD.dump`.
2. Check that caches match journals; each query below must return 0:

```sql
select count(*) from party_balances pb
left join (select party_type, party_id, sum(debit_paise - credit_paise) t from ledger_entries group by 1, 2) le using (party_type, party_id)
where pb.balance_paise <> coalesce(le.t, 0);

select count(*) from stock_levels sl
left join (select product_id, sum(qty_base) t from stock_movements group by 1) sm using (product_id)
where sl.qty_base <> coalesce(sm.t, 0);
```

3. Compare a few bills, customer balances and stock figures with the live app, then delete the scratch database.

## 5. Rollback

- **Bad app release, schema unchanged or additive:** in Vercel, Deployments → previous production deployment → **Instant Rollback**. Safe because migrations are backward-compatible.
- **A migration broke something:** do not edit or reverse the migration. Ship a new forward migration that fixes it, or roll the app back if the old build still works on the new schema.
- **Data damaged** (bad import, operator mistake): prefer fixing with the app's own reversals (credit notes, adjustments, receipt reversal) so the audit trail stays complete. Only if that's impossible: restore point-in-time into a **new** instance just before the incident, verify with the queries above, then switch `DATABASE_URL`/`DATABASE_MIGRATION_URL` to it and redeploy. Entries made after the restore point must be re-entered; take the list from the old instance before switching.
- Write down every rollback (time, reason, what was restored) for the owner.

## 6. Security checklist before go-live

- [ ] Secrets only in Vercel environment variables; none in Git (`.env*` is ignored; only `.env.example` placeholders).
- [ ] `SETUP_TOKEN` removed after setup; `SEED_ALLOW` unset.
- [ ] Database not publicly reachable; TLS required; app connects as `nexora_app`.
- [ ] Owner PIN set; staff accounts per person; nobody shares the owner login.
- [ ] HTTPS only (HSTS is sent in production); custom domain with Vercel-managed certificate.
- [ ] Backups and PITR on; first restore drill done.
