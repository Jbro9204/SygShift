# Scheduler Draft Add-Shift Repair

Date: 08/20/2026

## Reported issue

Adding an additional employee to an already published schedule week could fail with:

`duplicate key value violates unique constraint "schedules_one_published_week_unique"`

The reported case was Dispatch Phone Coverage on 08/27/2026 from 06:00 AM to 02:30 PM, where Lorinda Hood and Michael Hinz both needed coverage assignments during the same window.

## Root cause

The Add Shift screen described the operation as a draft edit, but a legacy database path still created and immediately published a new schedule revision. When that week already had a live revision and an open working draft, the legacy path attempted to create a second published revision and correctly triggered the database integrity constraint.

## Changes completed

- Repaired the authoritative add-shift database transaction to reuse the single working draft for the selected week.
- Added an advisory transaction lock so simultaneous draft operations cannot create competing drafts.
- Preserved the currently published schedule until an authorized user intentionally publishes the working draft.
- Kept newly requested opening announcements unpublished while their shift remains in draft; they activate when the schedule is published.
- Added an audit event for each shift added to a working draft.
- Updated the Add Shift dialog language to state that the action saves to the working schedule draft.
- Added regression coverage for draft reuse, publication safety, deferred announcements, and user-facing draft language.

## Verification

- Application quality suite passed: 52 test files and 280 tests.
- Type checking, linting, and the production build passed.
- The production database migration applied successfully.
- A rollback-only production transaction reproduced the exact Dispatch coverage date, time, post, and employee combination.
- The verification confirmed that the assignment saved successfully to a draft while exactly one schedule revision remained published.
- No test shift or assignment was retained by the production verification.

## Operational result

Schedulers can add parallel Dispatch coverage to the working draft without colliding with the already published schedule. Saving the shift does not republish the week. The revised schedule becomes visible to employees only after the normal intentional publish step.
