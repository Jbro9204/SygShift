# Salaried Shift Confirmations

Date: 09/29/2026
Status: Released to production

## Outcome

SygShift now tracks whether a salaried employee worked a scheduled shift
without treating that employee as hourly. Authorized managers receive one
dedicated **Salaried Shifts** workspace where an ended scheduled shift can be
marked **Worked** and an incorrect marker can be removed with an audited
reason.

This release deliberately records the whole scheduled shift only. It does not
store arrival time, departure time, worked minutes, breaks, overtime, payroll
hours, or a clock punch, and it does not change the underlying schedule
assignment.

## Workspace and workflow

- Added `/shift-confirmations` and an Operations navigation item named
  **Salaried Shifts**, plus a contextual link from Schedule.
- Added date, employee, status, and text filters with responsive layouts,
  loading, empty, error, retry, saving, and completion states.
- Separates shifts into **Ready to mark**, **Upcoming shifts**, and **Worked
  shifts**. Future shifts stay neutral and cannot be marked before their
  scheduled end.
- Shows the scheduled date, scheduled time, shift time zone, employee, site or
  post, current status, recorded note, actor, and complete marker history.
- Requires an explicit confirmation before adding a Worked marker and a
  meaningful reason before removing one.
- Uses one stable request identifier across identity-verification retries and
  manual lost-response retries so a repeated submission cannot create a second
  event.

## Eligibility boundary

- Includes only salaried employees assigned to a current published schedule.
- Includes standard assignments and the primary Dispatch shift.
- Excludes supplemental Dispatch phone duty, hourly and Flex employees,
  canceled shifts, canceled assignments, archived or draft-only schedule
  revisions, call-offs, approved Time Off, and future shifts from the actionable
  queue.
- Preserves continuity across schedule revisions while copied future weeks do
  not inherit prior Worked markers.
- Uses the scheduled shift as a reference only; the marker remains independent
  from Time & Attendance, payroll, and overtime calculations.

## Access and security

- Added the exact MFA-sensitive permission
  `schedule.salary_shifts.manage`.
- Default permission grants are limited to **Scheduler**, **Supervisor**,
  **Operations Manager**, **Human Resources Manager**, and **Admin**.
- Navigation and route guards enforce the permission in the application. The
  database RPC independently enforces the effective permission and employee
  identity.
- Presence events and idempotency receipts are private, RLS-protected, and have
  no direct authenticated browser read or write grants. Mutations use a narrow
  security-definer RPC with append-only audit evidence.
- Corrections preserve the original Worked event and append a separate void
  event; history is never overwritten.

## Database implementation

- `20260929132655_salaried_shift_presence_tracking.sql`
  - Adds the permission, role defaults, private event/receipt storage, protected
    read workspace, and mutation RPC.
- `20260929132854_salaried_shift_presence_fk_indexes.sql`
  - Adds covering indexes for the new foreign-key paths.
- `20260929133936_salaried_shift_presence_consistency_repair.sql`
  - Uses the submitted Time Off time zone for exclusion checks and aligns lock
    order with the existing schedule workflow.
- `20260929135819_salaried_shift_workspace_boolean_contract_repair.sql`
  - Guarantees concrete boolean action flags for assignments without prior
    events. This was caught by the authenticated production postflight before
    release completion.

All migrations are additive and forward-only. Existing schedule, assignment,
timekeeping, payroll, notification, and audit records were preserved.

## Verification

- Full repository gate passed: strict TypeScript, zero-warning application and
  Worker lint, **334 files / 1,765 tests**, production Worker/client builds, and
  the static-asset contract.
- Focused application coverage passed for routing, effective permissions,
  navigation, maintenance controls, payload validation, responsive workspace
  states, correction notes, duplicate-submit prevention, identity retries, and
  manual lost-response retries.
- Mandatory Time Clock preservation passed **42/42** desktop/mobile checks for
  clock-in, early-clock acknowledgment, multiple-shift selection, break/resume,
  clock-out, repeated submissions, role boundaries, and immediate cross-page
  synchronization.
- The linked rollback-only salaried-shift lifecycle regression passed before
  installation and again against the installed production functions. It proves
  eligibility exclusions, whole-shift behavior, DST dates, revision continuity,
  idempotency, correction history, permissions, MFA, no direct table access,
  and no time/payroll mutations.
- Production payload postflight returned **55** valid scheduled assignment rows
  and zero non-boolean action flags.
- Authenticated production UI verification loaded the complete Salaried Shift
  workspace with filters, counts, upcoming shifts, and actionable **Mark
  Worked** controls. Signed-out access redirects to `/login`.

## Production release references

- Implementation commit: `3b36035`
- Production contract repair commit: `d6cd949`
- Production migration ledger:
  - `20260929132655`
  - `20260929132854`
  - `20260929133936`
  - `20260929135819`
- Cloudflare Worker version: `33649eac-1aab-4287-a254-95cbc245c196`
- Rollback tag: `rollback/pre-salaried-shift-confirmations-20260929`
- `https://app.sygilant.us/api/v1/health` returned HTTP 200 and status `ok`.
- `https://app.sygilant.us/api/v1/ready` returned HTTP 200 with every required
  binding ready.
- Exact live assets matched the fresh local production build:
  - `index-CUtqFOFV.js` (`8e6185ba...a8fb`)
  - `SalariedShiftConfirmationsPage-oXSRbLJx.js` (`e686dbf8...b2b0`)
  - `index-Ba_yD1hJ.css` (`f593d24d...225c`)
- Desktop archive copy:
  `C:\Users\Jordan\Desktop\SygShift Changelogs\CHANGELOG_09-29-2026_SALARIED_SHIFT_CONFIRMATIONS.md`.

## Operator notes

Use **Worked** only to confirm that the salaried employee covered that scheduled
shift. Continue to use the existing call-off and Time Off workflows when the
employee did not work. This workspace is not a timesheet and must not be used to
infer hours, overtime, payroll, late arrival, or early departure.

If a database correction is ever required, add a new forward migration. Do not
edit an applied migration or delete marker history.
