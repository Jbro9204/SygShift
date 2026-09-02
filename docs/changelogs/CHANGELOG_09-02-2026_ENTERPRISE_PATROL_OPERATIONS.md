# Enterprise Patrol Operations

Date: 09/02/2026

## Outcome

SygShift Patrol is now a connected operational workspace for guards and management instead of a schedule-only summary. Published Schedule shifts remain authoritative; managers connect an approved, versioned patrol route to the assigned employee and shift.

## Guard workflow

- Added a focused My Patrol worklist with required, completed, missed, makeup, and extra-hit states.
- Every submitted hit requires a meaningful note and outcome. Optional time windows, spacing, sequence, location verification, and evidence rules are enforced by the server when configured.
- Extra hits require a reason and remain separate from required-hit compliance totals.
- Photos and videos use a private 500 MB evidence vault, signed resumable uploads, content-signature validation, protected preview/download, and access audit history.
- Standard and incident video limits are configurable by route; the default builder supports three-minute standard videos and longer incident evidence.

## Management and reporting

- Added versioned route building with armed/unarmed requirements, reusable Sites/Posts, editable stop details, per-day hit counts, optional time windows, and configurable photo/video requirements.
- Seeded the supplied MG Properties and Armed patrol spreadsheet requirements as editable drafts without inventing addresses or times.
- Added live assignment progress, missed-hit reconciliation, same-route makeup assignment, and an actual guard-facing Complete Makeup workflow.
- Added Patrol Activity reporting to the Reports library with required, extra, and makeup activity; internal and client-ready views; and audited CSV, Excel, and PDF exports.
- Kept all operational lists compact with 5/10/20 row controls; overview and exception previews are capped at five or ten records.

## Security and preservation

- Added focused Patrol permissions and server-side ownership/authorization checks.
- Kept the evidence bucket private; browsers never receive a service credential or a public object URL.
- Required recent MFA/security-key verification for management access to another employee's evidence and for sensitive Patrol administration/reporting permissions.
- Added database preservation assertions for employees, schedules, shifts, assignments, time events, access-role assignments, and individual permission overrides.
- Existing Schedule, Time & Attendance, Payroll, Licensing, employee, and audit records were not rewritten.

## Production verification

- Executed the complete migration in a production transaction followed by rollback before release; all SQL, constraints, seeds, and preservation assertions passed.
- Applied the Patrol foundation plus focused forward hardening for administrator MFA, complete makeup/reporting, and exact evidence-target binding; no unrelated migration was replayed.
- Verified two editable draft routes, 11 stops, 61 weekly requirements, the private evidence bucket, and the protected Patrol functions in production.
- Type checking and zero-warning lint passed.
- All 147 unit/integration test files and 715 tests passed.
- Worker and client production builds passed.
- Four desktop/mobile light/dark rendered checks passed with no accessibility violations or horizontal overflow.

## Rollback

This is a forward-only additive release. The seeded routes are drafts and do not alter published shifts until a manager deliberately activates a route and connects it to a Schedule assignment. If application rollback is required, deploy the preceding Worker/Git revision; preserve Patrol tables, evidence metadata, and audit history for recovery. Any later database correction must be made through a new forward migration.
