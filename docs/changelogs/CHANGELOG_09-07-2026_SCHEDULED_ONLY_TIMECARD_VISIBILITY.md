# Scheduled-Only Timecard Visibility Repair

**Released:** September 7, 2026

## What was reported

Michael Hinz could not open John Holliday's September 5 timecard after adding John's schedule. John also could not be found through Team Attendance search because he had no clock activity for that day.

## What was found

- John Holliday is active and has one assigned shift on September 5 in published schedule revision 24, the latest published revision for that week.
- The scheduled shift totals 210 minutes and John has no time events for that workday.
- The production Team Attendance database function correctly returns John, his published shift, and the zero-punch state when evaluated under Michael's authorized account context.
- The Team Attendance page then applied a second visibility filter that retained punches, worked minutes, corrections, overtime, breaks, or an active clock state, but omitted the scheduled-shift count. That discarded a valid scheduled-only employee before search and detail review.

## Repair

- Team Attendance now retains employees with one or more published scheduled shifts even when they have no punches or other time activity.
- Michael can find John by name or username, expand his Team Attendance row, and open **Employee Time** for the selected date range.
- Employees with neither a published schedule nor time activity remain outside the activity list, preserving the intended signal-to-noise behavior.
- No schedule, time event, payroll record, role, permission, or database function was changed.

## Regression protection

- Added a focused test proving a scheduled-only employee remains visible and searchable in the Team Attendance data set.
- Added a companion test proving a truly inactive employee with no schedule and no time activity remains omitted.
- Moved the pure row-building logic into a dedicated module so this edge case can be tested without changing page behavior.

## Verification

- Production diagnosis confirmed the exact live record state and the authorized server response without writing data.
- `pnpm check` passed type checking, zero-warning lint, all 187 test files / 925 tests, and the production build.
- The complete Playwright suite passed all 214 desktop and mobile checks.
- The dedicated time-clock workflow passed all 38 desktop and mobile checks, including early-clock acknowledgment, normal clock-in, breaks, clock-out, permissions, and duplicate-submit protection.
- A fresh post-browser production build completed successfully.
- Production `/api/v1/health` returned `ok`; `/api/v1/ready` returned `ready: true`; `/login` and `/time/team` returned HTTP 200.
- The live Team Attendance asset is an exact SHA-256 match to the tested release build.
- No production time, schedule, or payroll data was changed during verification.

## Release

- Application commit: `637b808`
- Cloudflare Worker version: `7a26fab1-b36f-490e-ac79-100c55762c6b`
- No database migration was required.

