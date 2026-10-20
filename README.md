# SygShift

SygShift is a workforce-operations application for security scheduling, employee qualifications, events, timekeeping, time off, announcements, and payroll preparation.

## Maintainer start here

Before changing SygShift on any workstation, read [AGENTS.md](AGENTS.md) and the complete [Build and Handoff Guide](docs/BUILD_AND_HANDOFF_GUIDE.md). These files define the required repository checks, architecture and security boundaries, interface standards, database process, QA gates, deployment workflow, and cross-computer handoff procedure.

## Local setup

Requirements:

- Node.js 24.19.0 (pinned in `.node-version`)
- pnpm 11.25.0 (pinned in `packageManager`)
- A Supabase project for authenticated data access
- A Cloudflare account for preview and production deployment

Install dependencies and create local browser configuration:

```powershell
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm setup:git-hooks
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

`pnpm check` runs exact-toolchain validation, type checking, linting, unit/regression tests, release-control tests, and the production build together.
It first rejects a Node.js or pnpm version that differs from the reviewed release toolchain. `pnpm release:verify` is the required complete gate for a `main` candidate: it runs `pnpm check`, the isolated mandatory Time Clock browser workflow, and a fresh build. The Time Clock workflow uses a standalone loopback fixture and always runs its desktop and mobile Chromium projects; it does not start unrelated Playwright fixture servers.

For a `main` release candidate, the local setup above installs the reviewed browser runtime and the versioned Git hook. If either is missing in an existing clone, restore it before working on a release candidate:

```powershell
pnpm exec playwright install chromium
pnpm setup:git-hooks
git config --get core.hooksPath # must print .githooks
git ls-files --stage .githooks/pre-push # must show mode 100755
```

The hook creates a clean detached candidate worktree, runs the locked install, production audit, mandatory Time Clock browser workflow, and fresh build, then confirms the remote tip has not moved. Do not bypass it. If it reports a retained candidate path or lock, keep the terminal output, confirm its recorded process is stopped, and remove only the listed owned paths—not a broad temp or Git directory. Candidate commands receive a deliberately narrow environment and isolated temporary home, but this is not a security sandbox for files the invoking user can read. After push, confirm the exact SHA is green in both the **Exact candidate quality gate** and **CodeQL JavaScript and TypeScript** jobs before treating the work as complete.

## Deployment

Cloudflare configuration is stored in `wrangler.jsonc`. The Worker serves versioned routes under `/api/v1`; static assets and client-side routes are served as a single-page application.

```powershell
pnpm deploy
```

Use [docs/PRODUCTION_CUTOVER.md](docs/PRODUCTION_CUTOVER.md) for the full Cloudflare + Supabase launch checklist, including credential rotation, Worker secrets, readiness checks, and first-admin verification.

Use [docs/BOSS_BUILD_EXPLANATION.md](docs/BOSS_BUILD_EXPLANATION.md) for a plain-English explanation of what is being built, what is already working, what remains before rollout, and the realistic launch path.

Use [docs/ROLL_OUT_STATUS_20260704.md](docs/ROLL_OUT_STATUS_20260704.md) for the latest verified deployment, database, schedule, and advisor status.

Use [docs/PILOT_TEST_PLAN.md](docs/PILOT_TEST_PLAN.md) to run the first controlled real-world test with one admin, supervisors, and a small guard group.

Use [docs/PAYROLL_EXPORT_VALIDATION.md](docs/PAYROLL_EXPORT_VALIDATION.md) to validate timekeeping and payroll export accuracy before any payroll run depends on SygShift.

Use [docs/security/ACCESS_CONTROL_INVENTORY_08-21-2026.md](docs/security/ACCESS_CONTROL_INVENTORY_08-21-2026.md) for the verified permission-enforcement baseline, current production role matrix, and prioritized access-control gap register.

Production deployment requires successful quality checks, database migrations, row-level security verification, source reconciliation, accessibility review, and a tested backup restore.

## Repository boundaries

Source workbooks, extracted employee data, environment files, database exports, screenshots, and test reports are intentionally excluded from Git. Application code, migrations, tests, and documentation are committed after each verified development unit.
