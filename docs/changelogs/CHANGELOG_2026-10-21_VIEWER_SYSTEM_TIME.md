# Viewer System Time for Header and SygSphere

Date: 10/21/2026
Scope: Main SygShift header, SygSphere visible timestamps, and SygSphere-linked Client Communications timestamps
Production deployment: Pending promotion after successful release verification
Database migration: None

## Outcome

The main header clock and visible SygSphere timestamps now display in the signed-in viewer's browser/device system time zone. A user whose device is set to Eastern Time sees Eastern time; a user whose device is set to Mountain Time sees Mountain time. Daylight-saving abbreviations update for the displayed instant.

The header remains anchored to server time so an inaccurate device clock cannot change the authoritative current instant. Only the presentation time zone comes from the viewer's device.

## Visible surfaces corrected

- Main header date, time, time-zone label, and accessibility description.
- SygSphere conversation messages, thread replies, and focused messages.
- SygSphere read-receipt timestamps.
- SygSphere Search and Saved result timestamps.
- Client Communications rows that link to SygSphere conversations.

## Preserved behavior

- Stored timestamps remain UTC.
- Employee-profile, site, and schedule time zones remain authoritative for Schedule, My Time, timekeeping, and operational workflows.
- No punches, schedules, payroll calculations, employee records, permissions, or audit records changed.
- If a browser cannot provide a valid system time zone, the header uses the employee-profile zone when valid and otherwise falls back safely to UTC.

## Verification

- Targeted system-time, SygSphere formatting, header rendering, tab-visibility, and source guard tests: 19 passed.
- Full SygSphere desktop/mobile browser suite: 84 passed.
- TypeScript typecheck: passed.
- Zero-warning lint: passed.
- Full application suite: 381 files and 2,216 tests passed, with one intentional skipped file/test.
- Release-governance suite: 174 passed.
- Protected Time Clock desktop/mobile browser suite: 42 passed.
- Production build and static-asset contract: passed.
- Independent review found no missed visible SygSphere timestamp surface and confirmed that timekeeping and payroll logic were not changed.
- Production promotion and live health checks: pending.

## Remaining limitations

- None known for normal browser/device use. A browser that does not expose an IANA system time zone uses the documented safe fallback instead.
