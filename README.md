# SygShift

SygShift is a workforce-operations application for security scheduling, employee qualifications, events, timekeeping, time off, announcements, and payroll preparation.

## Local setup

Requirements:

- Node.js 22 or later
- pnpm 10 or later
- A Supabase project for authenticated data access
- A Cloudflare account for preview and production deployment

Install dependencies and create local browser configuration:

```powershell
pnpm install
Copy-Item .env.example .env.local
pnpm dev
```

Only the Supabase URL and publishable key belong in `.env.local`. Secret keys, service-role keys, database passwords, and integration credentials must be configured as server-side secrets.

## Quality checks

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

`pnpm check` runs type checking, linting, unit tests, and the production build together.

## Deployment

Cloudflare configuration is stored in `wrangler.jsonc`. The Worker serves versioned routes under `/api/v1`; static assets and client-side routes are served as a single-page application.

```powershell
pnpm deploy
```

Production deployment requires successful quality checks, database migrations, row-level security verification, source reconciliation, accessibility review, and a tested backup restore.

## Repository boundaries

Source workbooks, extracted employee data, environment files, database exports, screenshots, and test reports are intentionally excluded from Git. Application code, migrations, tests, and documentation are committed after each verified development unit.
