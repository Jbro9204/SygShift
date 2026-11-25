# Guard call-off through required actions — 11/25/2026

Status: local application candidate. No database migration, production record write, email delivery, or deployment is part of the local verification.

## Issue and repair

- The required-actions checkpoint allowed `/time/my-time?report=call-off`, but My Time removed that query parameter immediately after opening the form. The next route check redirected the employee away. The form also waited for an unrelated payroll-period lookup.
- The same bookmark now opens the focused attendance form and keeps the route intact. The ordinary My Time screen, its clock and payroll controls, and all other route permissions remain separate.
- The form can still offer the existing date-only path if assigned shifts are slow or unavailable. It never guesses the date when the server date is unavailable. A failed or unconfirmed save preserves the note; the existing attendance action and its canonical retry, audit, Dispatch, and scheduling behavior are unchanged.
- Changes are confined to the SygShift application shell and time components, focused and composed tests, and this changelog. No schedule, punches, payroll, account, required-action rollout, or permission logic changed. Shift lookup uses an employee-scoped cache cleared when the user signs out.

## Verification and release

- The composed AppShell tests exercise the real checkpoint link and form with synthetic sessions, no payroll read, successful confirmed dispatch, failed shift lookup, manual date-only submission, unconfirmed Dispatch, retry, cancel/reopen, and denial of unrelated routes, missing authorization, or an incomplete password checkpoint. No real attendance report is sent.
- Local `pnpm release:verify` passed: TypeScript, lint, 2,680 application tests in 413 files (one existing test/file skipped), the isolated PostgreSQL and release checks, all 42 Chromium clock scenarios (21 desktop, 21 mobile), and a fresh production build with the static-asset contract. No production attendance submission or punch was used.
- A fresh read-only production capture independently confirmed the shared ledger in `docs/reliability/migration-ownership-2026-11-25-company-requests-v2.json`: 475 applied versions, 607 owning sources, all 474 predecessor entries unchanged, and only the previously installed company Requests migration added. Existing review exceptions remain unchanged. This is release evidence, not a new database change. The v2 readback and all 26 focused database-gate tests passed.
- The standard exact-commit candidate verification, time clock browser suite, GitHub quality gate, and rollback-safe Worker promotion are required before release. Production Guard Mode acceptance is separate from these isolated tests.
- Roll back to the exact previous verified Worker version if the approved deployment's health and readiness gate requires it. There is no data or migration rollback for this application-only repair.
