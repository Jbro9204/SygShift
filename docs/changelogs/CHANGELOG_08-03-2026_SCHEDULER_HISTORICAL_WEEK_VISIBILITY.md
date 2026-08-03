# SygShift Change Log — Scheduler Historical Week Visibility

Date: 08/03/2026

## Issue

The Scheduler could navigate to a previous week and load its stored schedule revision, but the Week Planner removed every shift dated before the current operational date. The summary could therefore report a populated revision while the planner displayed zero visible shifts and zero active sites.

## Resolution

- Historical shifts remain visible when their week is selected in the Scheduler.
- Site coverage and employee schedule views both retain the selected week's stored shifts.
- Past shifts do not count as current open slots or current review items.
- Fully historical weeks display a `Historical` status instead of presenting old coverage as an active staffing condition.
- Fully historical weeks are read-only in the Scheduler to protect completed operational history from accidental edits.
- The site summary now says `shifts this week` instead of the inaccurate `current/future shifts` label.

## Verification

- Type checking passed.
- Lint passed with warnings denied.
- All 161 automated tests passed.
- Production build passed.
- Added regression coverage ensuring past schedule weeks remain visible while old openings remain non-actionable.
