# November 9, 2026 — Published coverage retirement

Status: staged forward repair; native regression passed. Not yet applied to production by this change record.

## Verified cause

The naturally running minute scheduler began reporting `operational_alert_lifecycle_reconciliation_failed` at 14:00:53 UTC on November 8. Its last complete success was 13:59:59 UTC. A generated, unassigned vacancy ended at 13:00 UTC and reached the existing one-hour retirement threshold at 14:00.

The installed call-off retirement routine attempted to close the vacancy and write cancellation fields on its published schedule child. The published-schedule guard correctly rejected those cancellation changes. The alert transaction rolled back and prevented a full-success readiness watermark; other scheduled lanes continued. Cron and the coordinator were still operating.

## Narrow repair

Forward migration `20261109203718_published_coverage_retirement_immutability.sql` changes only the reviewed vacancy update inside `private.retire_call_off_live_artifacts`.

- Published, generated, unassigned vacancies close through `is_open` and `updated_at` only. Their existing cancellation fields and all other schedule data remain untouched.
- Non-published vacancies retain their existing cancellation behavior.
- Assigned replacements, shifts with active/confirmed/completed assignments, and non-generated shifts remain excluded.
- Existing coverage-case actions continue to retain the retirement reason and outcome. Existing alert, notification and call-off lifecycle processing remains authoritative.
- Repeated retirement does not rewrite a closed published vacancy or append another coverage-close action.

The migration fences the exact installed source and published-guard source, retains function security metadata, and changes no business rows during installation. It does not relax or replace the published-schedule guard.

## Verification

`node tools/published-coverage-retirement-postgres-regression.mjs` passed 34 checks in an isolated loopback PostgreSQL 18 cluster. It loads the actual prior retirement function and actual published-schedule guard, reproduces the original rejection, applies the forward repair, and verifies published/draft behavior, assigned and non-generated exclusions, retries, audit reason retention, unchanged guard, and preservation of schedules, assignments, source call-offs, punches and payroll fixtures.

No production mutation, forced scheduler invocation, credential action, email delivery, deployment or readiness override was performed by this regression. After the authorized production installation, observe the next natural minute cycle and confirm the readiness watermark advances; do not simulate a successful cycle.
