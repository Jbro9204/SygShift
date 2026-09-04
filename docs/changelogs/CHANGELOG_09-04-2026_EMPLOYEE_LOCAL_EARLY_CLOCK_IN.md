# Employee-local early clock-in warning

Released: 09/04/2026

## Outcome

The forced early clock-in alert now presents the employee's schedule in the employee/device time zone instead of showing only the shift/site or Mountain system time. A Central employee assigned to an 8:00 AM Central shift sees 8:00 AM Central throughout the warning, including the opening of the five-minute clock-in window.

## Behavior

- The browser's supported continental-US system zone is used for personal presentation.
- The employee profile zone is the safe fallback when device-zone detection is unavailable or outside the supported four zones.
- Current time, clock-in opening time, shift date, shift start, and shift end use the same personal display zone and include the active time-zone abbreviation.
- Mountain server time remains visible as a secondary verification reference.
- Trusted database server time still decides whether clock-in is allowed.
- Changing a computer clock or display zone cannot move the five-minute eligibility boundary.
- The existing required acknowledgement remains non-dismissible and does not create a time punch.

## Centralized implementation

- `src/components/EarlyClockInWarningDialog.tsx`
- `src/data/timekeeping.ts`
- `supabase/migrations/20260904122352_employee_local_early_clock_in_display.sql`

The existing shared dialog/hook continues to cover Home, My Time, and Time & Attendance.

## Verification

- TypeScript passed.
- Zero-warning lint passed.
- 163 test files / 785 tests passed.
- Production Worker and client builds passed.
- The production database function returns employee time-zone context while remaining unavailable to `anon` and executable only by authenticated users subject to its employee and permission checks.
- Primary and fallback production URLs returned HTTP 200.
- Live production assets contain the employee-local display, configured-zone fallback, and trusted-server explanation.

Implementation commit: `5f4767c`

Cloudflare version: `a2b8dbb7-e970-4873-9b7f-9c62c23bb847`
