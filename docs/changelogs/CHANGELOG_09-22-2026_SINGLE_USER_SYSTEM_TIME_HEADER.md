# Single User System-Time Header

Date: 09/22/2026
Status: Released to production

## Outcome

The global SygShift header now shows one compact digital system time for the
person using the application. The Pacific, Mountain, Central, and Eastern
analog clock cards and their scrolling/responsive strip have been removed.

## Time behavior

- The display remains synchronized from the existing trusted server timestamp;
  it does not use the browser clock as an authoritative source.
- The viewer's supported continental-U.S. browser time zone controls the visible
  time and date. If the browser cannot provide a supported zone, the signed-in
  employee profile time zone is used.
- The normal civilian time and existing parenthetical 24-hour teaching format
  remain unchanged.
- The time-zone name and current daylight/standard abbreviation remain visible.
- The header remains informational and cannot authorize or create punches.

## Interface and accessibility

- Removed every analog clock face and the four-zone clock strip.
- Kept one readable system-time region with an explicit accessible label.
- Preserved the static date, appearance controls, notification center, account
  identity, Sign Out, workspace alerts, and mobile navigation.
- Kept the time display contained without horizontal scrolling from 320 through
  1920 pixels, in light and dark mode, with reduced-motion settings, and within
  the SygSphere shell.
- On the narrowest 320-pixel layout, the redundant visual **System time** badge
  is hidden while the digital time, time-zone label, and complete accessible
  system-time label remain available.

## Preservation

- No database migration was required.
- No employee, schedule, assignment, punch, timecard, payroll, permission,
  notification, or audit record was changed.
- Early clock-in calculations, employee-local schedule presentation, server
  time authority, and Time Clock actions were not changed.

## Verification

- Full `pnpm check`: 301 test files / 1,604 tests, strict TypeScript,
  zero-warning application lint, Worker build, client production build, and
  static-asset contract.
- Global header browser matrix: 22/22 desktop and mobile checks at 1920, 1440,
  1280, 1024, 768, 390, and 320 pixels, including accessibility and dark mode.
- Affected SygSphere shell checks: 10/10 across phone and laptop layouts.
- Mandatory actual-component Time Clock workflow: 42/42 desktop and mobile
  checks, including early-clock-in acknowledgment and same-shift return.

## Release references

- Database migration: none
- Source commit: `48a034d`
- Cloudflare Worker version: `d8c7bd86-35f1-4e5e-a771-62badf13e826`
- Rollback tag: `rollback/pre-single-user-system-time-header-20260922`
- Production verification: both the custom domain and Worker origin returned
  healthy/ready; the live HTML referenced `index-B3pvhMFu.js`, whose bundle
  contains the single system-time presentation and no four-zone region label.
  The live stylesheet contains `.user-system-time` and no `.operational-clock`
  selector.
