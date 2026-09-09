# 09/09/2026 — Dispatcher Role and Landing Repair

## Outcome

- Restored the canonical protected Dispatcher role instead of creating a duplicate role that would
  disconnect primary-role, MFA, schedule, timekeeping, and notification behavior.
- Restored the four established Dispatcher permissions that had been disabled: Home / Operations,
  Scheduler, Reports, and Timekeeping Reports.
- Both active Dispatcher employees inherit the repaired permission bundle automatically; no employee
  was reassigned and no account, schedule, shift, time, or MFA record was changed.
- Replaced the unauthorized-route redirect loop with an authorized landing resolver. A valid signed-in
  employee who cannot open a requested route now reaches the first permitted workspace instead of a
  blank screen.

## Root cause

The production access audit showed that the protected `system_dispatcher` role was saved on
08/31/2026 without four permissions that had been part of its prior bundle. The two active Dispatcher
employees still had the correct primary role, but neither inherited `operations.view`, which is the
permission required by the Home route. The previous route guard redirected unauthorized paths to Home;
an employee who also lacked Home access therefore entered a redirect loop that appeared blank.

## Access-control hardening

- Exact forward migration `20260909164732_repair_dispatcher_role_and_landing_access.sql` repairs the
  protected system role in place and records the changed bundle in the existing immutable audit stream.
- The audited role-permission save function now refuses to remove the four required Dispatcher
  workspaces while leaving all other Dispatcher permissions editable.
- Migration assertions preserve employee counts, access-role assignments, individual overrides, role
  records, every other role bundle, and all unrelated Dispatcher permissions.
- A rollback tag was created before the release:
  `rollback/dispatcher-role-access-repair-pre-release-20260909`.

## Verification

- Production verification found two active Dispatcher employees, all four required role permissions
  enabled, zero missing required effective permissions, zero direct denials, and zero additive
  Dispatcher assignments.
- `pnpm check` passed 218 test files / 1,088 tests, TypeScript, zero-warning lint, Worker build, and
  client build.
- The focused access-control and mandatory Time Clock browser matrix passed 44/44 desktop and mobile
  checks, including Dispatcher clock controls.
- Linked database lint did not identify the repaired permission function. It continues to report older,
  unrelated function issues that predate this release.
