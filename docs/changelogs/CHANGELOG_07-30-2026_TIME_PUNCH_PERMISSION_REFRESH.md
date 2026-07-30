# SygShift Dev Log — 07/30/2026 — Time Punch Permission + Refresh Guard

## Completed

- Added a dedicated `time.punch` permission to the AD-style permission catalog.
- Granted `time.punch` to the core active employee system roles:
  - Guard
  - Dispatcher
  - Scheduler
  - Recruiting & Licensing
  - Supervisor
  - Admin
- Hardened the live database time clock RPC so employees must have `time.punch` or `time.manage` before recording a punch.
- Hardened the timekeeping dashboard RPC so only employees with valid time-related access can load the time clock data.
- Kept the actual time record source of truth on the server:
  - server time remains official
  - client/device time is still only audit context
  - idempotency still prevents duplicate punch requests
- Strengthened frontend refresh after clock actions so the following active screens refetch immediately after a saved punch:
  - Overview quick clock
  - Time & Attendance
  - My Time
  - Time Command Center
  - Active time review/maintenance data
- Updated navigation permission matching so the Time area recognizes the new `time.punch` permission.

## QA

- Typecheck passed.
- Lint passed.
- Test suite passed: 112/112 tests.
- Production build passed.
- Live Supabase SQL patch applied directly through the linked Supabase project query path because the historical migration queue contains older mismatched records.

## Notes

- The migration file is idempotent and safe to rerun.
- Supabase migration history still has pre-existing inconsistencies from older project work; this update avoided broad migration repair so the production database was not disturbed beyond the targeted Time permission patch.
