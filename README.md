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

Browser-delivered values use the `VITE_` prefix. Service-role keys, database passwords, and integration credentials are local/server-only values and must never be committed or exposed to browser code.

## Supabase activation

After the Supabase project is created and migrations are applied:

1. Put the browser-safe project URL and publishable key in `.env.local`.
2. Put the service-role key in `.env.local` only long enough to run local setup commands, or configure it as a server-side secret in the deployment environment.
3. Create the first administrator:

```powershell
$env:SYGSHIFT_BOOTSTRAP_PASSWORD = "<temporary-password>"
pnpm bootstrap:admin
Remove-Item Env:\SYGSHIFT_BOOTSTRAP_PASSWORD
```

The bootstrap account must replace the temporary password on first sign-in and verify MFA before privileged tools open.

Hosted Supabase Auth should also have leaked-password protection enabled (`password_hibp_enabled = true`). The current Supabase CLI config template does not expose that hosted setting in `supabase/config.toml`, so verify it in the Supabase Dashboard or Management API before production launch and after any Auth configuration push.

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
