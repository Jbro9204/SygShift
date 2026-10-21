# Clean System Clock Header

Date: 10/21/2026
Scope: Global SygShift header, including the compact SygSphere header
Database migration: None

## Outcome

The viewer-local system clock now appears as one uniform text line, such as `11:07 AM EDT`. The redundant friendly region label and separate `SYSTEM TIME` pill were removed.

## Preserved behavior

- The visible clock still uses the signed-in viewer's browser/device time zone.
- The current instant remains anchored to server time.
- The complete system-time meaning, date, and current abbreviation remain available to assistive technology.
- Stored timestamps remain UTC.
- No scheduling, punch, payroll, site-time, employee-profile, permission, or SygSphere message-time logic changed.

## Responsive presentation

- One text element now owns the time and abbreviation, guaranteeing consistent type size and weight.
- Desktop, laptop, phone, high-zoom, light-mode, dark-mode, and compact SygSphere layouts retain their existing responsive geometry.
- Obsolete region-label and pill-specific CSS was removed.

## Verification

- Header unit coverage validates device-zone selection, DST abbreviations, timer updates, visibility refresh, and removal of redundant visible labels.
- Responsive browser coverage validates containment from 1,920 pixels through 320 pixels.
- Existing SygSphere and protected timekeeping suites remain release requirements.
