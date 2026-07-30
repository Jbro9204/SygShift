# SygShift Changelog — 07/30/2026 — Time Clock Shift Picker Cleanup

## Issue addressed

Employees reviewing their time could see too many repeated schedule entries in the clock-in shift picker. This was especially bad for employees scheduled weeks in advance because the picker could feel like a schedule dump instead of a simple clock-in choice.

## What changed

- Added a shared timekeeping helper that turns raw assigned shifts into clean clock-in choices.
- The clock-in picker now shows only shifts available inside the active punch window:
  - 12 hours before shift start.
  - 6 hours after shift end.
- Exact duplicate shift choices are collapsed before they reach the employee-facing picker.
- The employee-facing Time page, My Time page, and Overview quick clock-in button now all use the same cleaned shift choice logic.
- Added a small professional note when future or duplicate schedule entries are hidden.
- Updated Supabase `get_timekeeping_dashboard` so the database only returns published assigned shifts inside the active punch window.
- Added backend duplicate collapse for identical employee shift choices.
- Added regression coverage proving future repeated shifts and duplicate entries do not flood the clock-in list.

## QA completed

- TypeScript typecheck passed.
- Lint passed with zero warnings.
- Full test suite passed.
- Production build passed.
- Live Supabase function was applied and verified for:
  - published schedule filtering,
  - punch-window filtering,
  - duplicate collapse.

## Expected user-facing result

Employees should no longer see 30 repeated versions of the same post when choosing what shift to clock into. They will see only the shift or small set of shifts that are actually eligible for clock-in right now, with future schedule entries hidden from the clock-in workflow.
