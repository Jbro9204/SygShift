# Guided Employee Lifecycle Release

Date: 2026-09-11  
Scope: Unified termination, offboarding, rehire, effective-date queue, and protected handoffs

## Outcome

SygShift now uses one guided Employee Lifecycle workflow for voluntary resignation, involuntary termination, job abandonment, end of assignment, and rehire. The Employee File no longer presents a separate immediate-termination dialog; its lifecycle action opens the same protected case and timeline.

The workflow is intentionally human controlled. Approval starts the checklist but never changes employment or access. A different qualified person must approve the request, and final execution requires recent HR MFA, `hr.people.manage`, `hr.offboarding.approve`, completion or a reasoned waiver for every required handoff, and exact entry of the employee username.

## Delivered

- Added a four-step, plain-language case wizard with employee search, lifecycle choice, effective date, business reason, automatic checklist explanation, and final review.
- Added clear Pending Approval, Approved/Scheduled, Due, In Progress, Completed, Denied, and Canceled lifecycle presentation.
- Added a live case workspace showing future assignments, pending time corrections, assigned property, leave state, and active restricted cases.
- Added 12 required handoffs for timecard, final pay, benefits, licensing, training, documents, property, schedule/coverage, client/site notices, communications, retention, and final account access.
- Added checklist ownership, due dates, completion evidence, and reasoned waivers.
- Linked the approved GS-HR-700 through GS-HR-704 library forms without copying the source files.
- Added independent maker-checker review, final human confirmation, Admin-only Admin separation, self-termination prevention, and the existing final-active-Admin safeguard.
- Reused the canonical separation transaction so account shutdown and future-work release preserve schedules, punches, timecards, payroll, licensing, documents, and audit history.
- Added a safe rehire path that moves a separated employee to Onboarding without silently restoring old access, MFA, roles, pay, licenses, or assignments.
- Added effective-date reminders and a prominent action-required notification. Scheduled processing is isolated so an offboarding reminder failure cannot interrupt timekeeping, alerts, patrol, signatures, or email processing.
- Added a permanent case event timeline and an exportable lifecycle queue.
- Added responsive, rounded, theme-compatible desktop and mobile layouts.

## Compatibility repair

One previously approved lifecycle case existed before the guided workflow and had no checklist. A second forward-only migration added the 12 missing handoffs and the correct approved document references to that case. It did not terminate the employee or change access. This prevents the legacy case from bypassing the new completion requirements.

## Data and security controls

- Browser requests remain behind the Worker boundary.
- Database functions independently require the service role, exact effective permissions, and the unified 30-minute HR MFA window.
- Restricted reasons remain inside the protected HR case. Operational notifications contain only the minimum action needed.
- No employee, schedule, shift assignment, punch, payroll row, license, document, or historical audit record was deleted.
- Pre/post counts remained: 80 employees, 38,677 shifts, 31,768 assignments, and 1,172 time events.
- The lifecycle release added 12 checklist records, two linked form references, and one explicit backfill event to the existing case.

## Verification

- Remote PostgreSQL transaction dry-run: passed before each migration.
- Remote migration and schema smoke test: passed.
- Full `pnpm check`: passed.
- Unit/regression suite: 242 files and 1,241 tests passed.
- Focused desktop/mobile lifecycle and User Accounts browser suite: six checks passed in light and dark modes.
- Production build: passed.
- Rollback reference: `rollback/pre-guided-offboarding-20260911`.

## Files

- `supabase/migrations/20260912110000_guided_offboarding_workflow.sql`
- `supabase/migrations/20260912111000_guided_offboarding_existing_case_backfill.sql`
- `worker/index.ts`
- `src/data/hrOffboarding.ts`
- `src/components/HrLifecycleCaseWizard.tsx`
- `src/components/HrLifecycleCaseDialog.tsx`
- `src/pages/HrisStage9Page.tsx`
- `src/pages/HrisEmployeeFilePage.tsx`
- `src/App.css`

