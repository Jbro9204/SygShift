# SygShift Release — Home Time-Off Request Workflow

**Release date:** 08/28/2026

**Production URL:** https://app.sygilant.us

## Outcome

Every signed-in employee with an active employee record can now submit planned time-off requests directly from Home. The workflow keeps planned leave separate from urgent sick/call-off reporting, applies employment-type eligibility on the server, preserves the submitted facts for audit, and reuses the existing Time-Off Requests review queue instead of creating a second process.

## Employee workflow

- Added one prominent **Request Time Off** action beside the existing urgent call-off action on Home.
- Made the action available to every active employee account, independent of administrative or custom workspace permissions.
- Added a focused, responsive request dialog with employee summary, leave type, full-day or partial-day dates and times, return date, affected published shifts, estimated scheduled hours, and an optional employee note.
- Hourly, Flex, and other non-salary employees can request **Sick Time** or **Unpaid Time Off**.
- Salary employees can request **Paid Vacation**, **Sick Time**, or **Unpaid Time Off**.
- Sick requests overlapping an active or imminent published shift are redirected to the urgent call-off workflow so Dispatch receives the correct operational notice.
- Successful submissions refresh the request summary immediately without requiring a page reload.
- Employees can still review request history and cancel eligible pending requests through the established request workspace.

## Review workflow

- Expanded the existing Time-Off Requests queue with a detailed review dialog.
- Reviewers can inspect the employee, employment-type snapshot, requested period, return date, affected published shifts, estimated hours, leave type, pay treatment, and employee note before deciding.
- Approval and denial use the established reviewer permission and MFA boundaries.
- A reviewer note is required for the decision.
- Decision status refreshes immediately and a status notification is queued for the employee.

## Data integrity and audit controls

- Added immutable submission snapshots so later employee, schedule, or classification changes cannot rewrite what was originally requested.
- Added decision snapshots containing the reviewer, action, time, reason, and reviewed request context.
- Preserved the existing request identity, queue, history, cancellation, notifications, and audit trail.
- Added server-side leave-type validation; the browser cannot grant a salary-only leave type to an ineligible employee.
- Added server-calculated affected-shift snapshots and estimated requested minutes.
- Kept approvals occurrence-specific; no decision weakens company policy or permanently changes employee eligibility.
- Added a protected employee decision-notification claim path to the existing Worker delivery pipeline.

## Database migration

- Added `supabase/migrations/20260828180000_home_time_off_request_workflow.sql`.
- Extended `public.time_off_requests` with request classification, pay treatment, return date, requested minutes, submission snapshot, affected-shift snapshot, and decision snapshot fields.
- Added protected functions for employee request context, request submission, reviewer context, request decisions, affected-shift calculation, and notification delivery.
- Preserved existing requests and the legacy review-function contract for compatibility.

## Interface quality

- Reused the SygShift dialog, status, field, button, loading, empty, validation, and responsive design language.
- Restored focus to the launching control when dialogs close.
- Prevented duplicate Home actions and kept the planned-leave action distinct from urgent coverage reporting.
- Added mobile layouts that keep labels, dates, affected shifts, and decision actions readable without overlapping controls.

## Regression protection

- Added workflow guards for universal active-employee access, salary/hourly eligibility, Home placement, affected-shift review, required decision notes, immutable snapshots, notification delivery, and responsive behavior.
- Updated application, request, worker, and employee-overview tests for the approved workflow.

## Validation

- Type checking passed.
- Linting passed with warnings denied.
- The complete automated suite passed: 95 test files and 485 tests.
- The production Vite build passed.
- Database and Worker production rollout were completed in dependency order.
- Production health and application smoke checks passed after deployment.

