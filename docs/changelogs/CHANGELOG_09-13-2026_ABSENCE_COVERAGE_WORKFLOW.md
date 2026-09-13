# Absence Coverage Workflow — September 13, 2026

## Outcome

SygShift now provides one guided manager workflow for turning a documented call-off into a safe coverage plan. The original employee assignment remains in permanent schedule history, while any replacement need receives its own linked coverage shift.

## Manager workflow

- Replaced the old one-step opening action with a three-step **Review absence → Choose coverage → Confirm** walkthrough.
- Shows the employee, original shift, time, location, and reported reason before the manager makes a coverage decision.
- Supports four explicit outcomes: assign a guard already found, publish an open shift, request a one-night Patrol review, or record that no replacement is needed.
- Searches eligible guards by name or employee number and explains availability, overlap, armed-credential, and overtime blockers.
- Requires an explicit management note and an additional overtime approval when the selected guard would enter scheduled overtime.
- Uses rounded, readable, evenly spaced controls with contained desktop and mobile layouts.

## Schedule and data integrity

- Stores an immutable snapshot of the original assignment, employee, shift, site/event, time zone, and shift times.
- Creates a separate one-person coverage shift instead of canceling or reusing the absent employee's assignment.
- Publishes the operational coverage block through a focused new schedule revision because published schedules are immutable.
- Preserves unrelated manager work by rebasing an existing schedule draft after the focused coverage revision is published.
- Carries active coverage cases, announcements, pending guard requests, and replacement assignments into later published schedule revisions.
- Revalidates guard availability, schedule overlap, armed qualifications, capacity, and overtime when management approves a request.
- Uses stable idempotency keys and same-plan replay protection so retries do not create duplicate shifts, announcements, or waves.

## Notification and Patrol behavior

- Keeps the opening visible in the normal open-shift pool.
- Sends eligible Flex guards first, other eligible non-overtime guards after 10 minutes, and overtime candidates after 20 minutes only when management enables that wave.
- Revalidates every recipient when a wave is delivered and excludes the employee's absence reason from guard-facing notifications.
- Patrol fallback creates a one-night Dispatch review request only; it does not silently alter a standing patrol route or create a permanent obligation.
- Reopening a Patrol-reviewed case correctly reactivates its opening, announcement, and notification waves.

## Attendance classification

- Added **Unexcused** as an explicit accountability review outcome.
- The outcome is a classification only. It does not assign points or change payroll because no attendance-points policy is active.

## Security and preservation

- Coverage management requires an active employee, MFA, and an existing effective management permission.
- Direct access to coverage cases, append-only action history, and private delivery waves remains closed to browser clients.
- The notification wave processor is service-role only.
- No existing employee, punch, payroll, assignment, call-off, schedule, permission, or account record was rewritten during verification.
- Rollback point: `rollback/pre-absence-coverage-workflow-20260913`.

## Verification before release

- Full repository gate passed: **255 test files / 1,305 tests**, TypeScript, zero-warning application lint, Worker build, and client production build.
- Full browser matrix passed: **328 passed / 12 intentional skips / 0 failures** across desktop and mobile.
- Mandatory Time Clock coverage passed as part of that matrix on both desktop and mobile.
- The new coverage layout passed at desktop and mobile widths with no horizontal overflow, readable 16px fields, rounded controls, and a visible sticky action row.
- A rollback-only production-data rehearsal passed migration compilation and the full lifecycle: create call-off, publish a separate opening, preserve the original assignment, rebase a manager draft, create a guard request, publish a later revision, remap the live case, approve the guard, close the opening, and replay idempotently. The rehearsal ended with `ROLLBACK` and committed no data.

## Release references

- Source commit: pending release
- Database migration: `20260913175135_absence_coverage_workflow.sql` — pending release
- Cloudflare Worker version: pending release

