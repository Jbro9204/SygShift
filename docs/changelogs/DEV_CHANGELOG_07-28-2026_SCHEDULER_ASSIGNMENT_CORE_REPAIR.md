# SygShift Dev Changelog — Scheduler Assignment Core Repair

Date: 07/28/2026

## Issue addressed

Scheduler assignment changes were not saving from the Scheduler shift modal. This affected:

- Assigning a known armed employee, such as Fernando, to an armed shift.
- Assigning an employee without an armed credential on file by using the armed override flow, such as Randy for a PERA shift.
- User confidence in whether the save actually worked, because the modal cleared itself even when the database rejected the save.

## Root cause

This was not a refresh-only issue. There were two core problems:

1. The Scheduler modal collected the armed override note, but the parent callback dropped that value before calling the schedule update mutation. The database never received the override reason.
2. The live database still had an older permission gate on the main schedule draft update function. That path required supervisor/admin access instead of the newer schedule-management permissions, so Scheduler-role users could be blocked even when their role should allow schedule work.

## What changed

- Repaired the Scheduler modal assignment callback so the armed credential override note is passed all the way into the schedule update API call.
- Stopped the modal from clearing the selected employee and override fields immediately after Save. Failed saves now keep the entered information visible.
- Added an inline Scheduler save error message so database/API failures are shown directly inside the modal instead of disappearing into a general page banner.
- Added `private.can_manage_schedule_drafts()` as the central MFA-protected database permission check for schedule draft edits.
- Replaced both live `public.update_schedule_draft_shift(...)` overloads so schedule draft editing now honors schedule-management permissions, scheduler-management permissions, supervisor/admin access, and MFA.
- Preserved armed credential enforcement for normal assignments.
- Preserved the armed credential override path, requiring the double-confirmed override note before assigning someone without an armed credential on file.
- Kept availability conflict override checks in the same save path.
- Included `recruiting_licensing` in the active employee roles that can be assigned where appropriate.

## Validation completed

- TypeScript typecheck passed.
- Lint passed with denied warnings.
- Automated test suite passed: 23 test files, 79 tests.
- Production build passed.
- Database migration applied directly to linked Supabase project.
- Live database function definitions verified:
  - Old supervisor/admin-only gate removed from both `update_schedule_draft_shift` overloads.
  - New `private.can_manage_schedule_drafts()` gate present.
  - Armed credential override argument present on the 11-argument overload.
- Cloudflare deployment completed.
- Live health endpoint passed.
- Live readiness endpoint passed.

## Deployment

- Cloudflare Worker version: `a21f8509-8f22-4161-8628-36d971881135`
- Live app: `https://app.sygilant.us`

## Notes

This update specifically targets the Scheduler shift assignment save path. It fixes the frontend handoff, database permissions, armed override save path, and visible failure feedback together so the issue is corrected at the core instead of masked at the screen level.
