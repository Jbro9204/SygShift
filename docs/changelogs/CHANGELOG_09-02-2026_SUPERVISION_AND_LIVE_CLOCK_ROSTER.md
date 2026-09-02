# Supervisor Scope, My Time Readability, and Live Clock Roster

Date: 09/02/2026

## Outcome

SygShift now keeps current clock status, historical Team Attendance, and Time Operations as distinct workflows. The Home **On duty now** card and Team Attendance **Clocked In** metric open a dedicated, automatically refreshed roster containing only employees with an open clock session.

## Workforce supervision

- Added one explicit, primary Assigned Supervisor relationship per employee. It is maintained from the authoritative Employee File and displayed from that same record in Directory.
- Chose employee-based reporting scope rather than inferring a supervisor from changing Site/Post schedules.
- Added **My Employees**, **All Employees**, **Unassigned**, and **By Supervisor** Directory views.
- Supervisors with direct reports default to My Employees; Admin keeps the complete company view by default and every authorized user can deliberately switch views.
- Kept reporting scope separate from permissions. Assigning a supervisor grants no role or permission and removes none.
- Preserved authorized cross-team help and records a readable audit event when a supervisor with an assigned team opens an employee outside that team.
- Added compact 5/10/20 Directory pagination instead of another long employee list.

## Current clock status

- Added `/time/on-duty` and a protected `get_live_time_roster()` database contract.
- The live roster uses each employee's latest effective, approved, non-voided punch and includes working and on-break open sessions.
- Displays status, clock-in time, elapsed time, Site/Post or event location, employee time zone, and Assigned Supervisor.
- Refreshes every 15 seconds and supports search, status filtering, manual refresh, and compact 5/10/20 pagination.
- Historical punches, correction queues, payroll totals, and maintenance tools remain in their existing workspaces and are intentionally absent from the live-only page.

## My Time readability

- Increased the shared Time snapshot label size from 13px to 15px, retained strong weight, and tightened letter spacing for clearer reading in both themes.
- Renamed the employee snapshot label from **Corrections** to the requested **Needs Review** while preserving the same pending-correction count.

## Security and preservation

- Supervisor assignment changes require `hr.people.manage`, MFA, an eligible active supervisor, and an 8–1,000 character reason.
- Eligible supervisors are active Supervisors, Admins, Operations Managers, or Human Resources Managers.
- Supervisor relationship data remains private and is available only through protected functions.
- Production preservation checks confirmed that employees, schedules, shifts, time events, access-role assignments, and individual permission overrides were not changed.
- The migration created no inferred supervisor assignments; HR must deliberately establish each reporting relationship.

## Verification

- Executed the complete migration in a production transaction followed by rollback before release.
- Applied only migration `20260902160000_supervisor_scope_and_live_time_roster.sql` and reconciled that exact migration marker.
- Verified both new production RPC contracts under an MFA-authenticated Admin context in a rollback-only transaction.
- Type checking, zero-warning lint, all 148 test files / 718 tests, and Worker/client production builds passed.
- All 68 desktop/mobile Playwright checks passed; the focused layout also passed Firefox with no accessibility violations or horizontal overflow.
- Deployed Cloudflare Worker version `0530a0ad-e53d-46ea-92aa-b8e7d301b225`.

## Rollback

This is a forward-only additive release. Application presentation can be rolled back by deploying the prior Worker/Git revision. Preserve supervisor assignments and audit events if the UI is rolled back; any database correction must use a new forward migration.
