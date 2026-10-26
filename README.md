# Nexora Business OS

Billing, pricing, stock, customer dues, purchases and daily closing for an Indian retail and wholesale shop (V1: one plumbing and building-materials shop).

Built with Next.js (App Router), TypeScript, Tailwind CSS, shadcn/ui, PostgreSQL 16 and Drizzle ORM.

## Quick start

```bash
npm ci
cp .env.example .env    # then fill in values; generate secrets with: npm run secret
npm run db:up           # local PostgreSQL in Docker
npm run db:migrate
npm run dev
```

Open http://localhost:3000. Full instructions, including first-run setup and development sign-in codes: [docs/setup.md](docs/setup.md).

## Documentation

- [docs/setup.md](docs/setup.md) — local setup, sign-in, tests, production requirements, known limitations
- [docs/database.md](docs/database.md) — schema, roles, migrations, seed data
- [docs/implementation-handoff.md](docs/implementation-handoff.md) — approved decisions and build phases
- [CLAUDE.md](CLAUDE.md) — rules for working in this codebase
