# SygShift Release — HR & Finance and Payroll Workspace

**Release date:** 08/28/2026  
**Production URL:** https://app.sygilant.us

## Outcome

Payroll is no longer buried beneath the long Time & Attendance workflow. It now has a dedicated, permission-aware home under **HR & Finance**, while Time & Attendance remains focused on punches, attendance, corrections, and operational review.

## Stage 1 — HR & Finance navigation

- Added the top-level **HR & Finance** navigation group.
- Added a focused **Payroll** destination shown only to employees with an applicable effective payroll/time permission.
- Registered protected routes for Overview, Review Queue, Employee Payroll, Export & History, and Rules.
- Preserved legacy `/time/payroll` and `/time/rules` links through safe redirects so bookmarks do not strand users.
- Rollback checkpoint: `11cb93c`.

## Stage 2 — Dedicated Payroll workspace

- Added a shared selected-pay-period control that persists through Payroll tabs and reloads using validated URL dates.
- Defaults to the configured current open period and retains current, previous, next, last-completed, and custom-range workflows.
- Clearly separates Week 1 and Week 2 throughout employee payroll review.
- Built a concise Overview with readiness, worked-time, exception, and lock status plus no more than five priority records.
- Built a focused Review Queue with search, status filter, priority sorting, and 10/25/50-row pagination.
- Built Employee Payroll as one compact row per employee with Week 1, Week 2, total payable, status, search, filters, sorting, and open-on-demand detail.
- Kept Export & History limited to preview, official lock, download, and locked-batch history.
- Kept company payroll Rules administrator-only.
- Preserved the existing calculation and mutation services rather than creating a second payroll engine.
- Rollback checkpoint: `68eeaf4`.

## Stage 3 — Time & Attendance compaction

- Added search, status filtering, sorting, and 10/25/50-row pagination to Team Attendance.
- Added search, priority/status filtering, sorting, and pagination to the Time Review Queue.
- Limited the Time Command Center live missing-clock-in list to five priority items with a link to the complete work queue.
- Kept selected-employee time maintenance and existing correction workflows intact.
- Rollback checkpoint: `a5aedcd`.

## Stage 4 — Security and regression protection

- Prevented the Payroll Rules query from running for a non-admin who navigates directly to the Rules URL.
- Added guards for the HR & Finance navigation boundary, focused routes, administrator-only Rules behavior, five-item Overview limit, and compact paginated lists.
- Added `docs/PAYROLL_WORKSPACE_PRESERVATION_MATRIX.md` documenting retained calculations, permissions, routes, and rollback expectations.
- Rollback checkpoint: `15c4df1`.

## Preserved business rules

- Payroll totals continue to use worked punch time rather than scheduled hours.
- Sunday-through-Saturday payroll weeks and biweekly Week 1/Week 2 separation remain unchanged.
- Overnight work remains attributed according to the existing operational occurrence and payroll-week rules.
- Exceptions, employee correction requests, sick/PTO categories, breaks, overtime, audit history, official locks, and workbook output remain backed by the existing production services.
- Export and Rules access remain permission controlled; Rules adds the stricter administrator-only interface and query boundary.
- No payroll records, punches, locks, employee access assignments, or production database rows were modified by this interface release.

## Responsive and usability work

- Desktop uses focused summaries and compact lists rather than a giant editable table.
- Tablet controls wrap without overlapping.
- Mobile presents Payroll navigation, period controls, summaries, queue items, and employee details as vertical touch-friendly cards.
- Existing labels, focusable controls, modal behavior, and status messaging remain available to keyboard and assistive-technology users.

## Validation

- Focused Payroll workspace guard tests passed.
- Type checking, linting, the full automated test suite, and the production build were run before release.
- Production health, readiness, and authenticated browser behavior are verified as the final release step after deployment.

## Remaining HR initiative

This release completes the Payroll foundation and HR & Finance navigation stage. The broader HR Center—private document storage, employee files, acknowledgments, onboarding/offboarding, restricted records, and HR reporting—remains active in the future-items plan and was not represented as complete by this release.
