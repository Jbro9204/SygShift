# SygShift Authoritative Overnight Occurrence Resolution

Date: 08/24/2026

## Outcome

SygShift now has one authoritative work-occurrence rule for overnight time. The clock-in that begins a work session establishes the operational workday and assignment; the later break and clock-out events inherit that same occurrence across midnight.

## Root cause

Several timekeeping workflows were independently inferring workday and shift identity. A stored shift link could be accepted even when the punch timestamp did not fit that shift, and some totals grouped each punch by its own calendar date. Those independent decisions could split one legitimate overnight session into two workdays or attach an evening clock-in to the prior night's shift.

## Correction

- Replaced the effective time-event resolver with a canonical occurrence resolver used by review, maintenance, attendance totals, payroll, and exports.
- Made the session clock-in authoritative for later punches in the same work session.
- Accepted a stored shift relationship only when the punch falls inside the shift's controlled four-hour pre/post working window.
- Repaired an invalid historical shift relationship only when exactly one assigned shift is a valid candidate.
- Left an event unscheduled when no deterministic candidate exists instead of guessing and silently assigning it to the wrong shift.
- Updated live clock-out and break recording to inherit the canonical occurrence after any audited correction.
- Updated supervisor-entered punches to reject a selected shift that cannot contain the entered timestamp.
- Updated Time Maintenance to display the same canonical Shift/Site/Post used for workday grouping.
- Updated team attendance totals to pair events by employee and resolved occurrence rather than calendar date.

## Record integrity

- No original punch was deleted or rewritten.
- Historical repairs are stored in the append-only occurrence-override ledger with the original shift, replacement shift, reason, source, creator, and timestamp.
- Explicit administrator occurrence corrections remain authoritative.
- Ambiguous or unsupported matches are not auto-repaired.

## Production verification

- Gaston Musambay's 08/12/2026 evening clock-in and 08/13/2026 morning clock-out share one 08/12/2026 occurrence.
- Gaston Musambay's 08/13/2026 evening clock-in and 08/14/2026 morning clock-out share one 08/13/2026 occurrence.
- Michael Hinz's invalid historical link was repaired to the single timestamp-compatible assigned shift.
- Covelle Padgett's unsupported historical link now remains one unscheduled overnight occurrence instead of being attached to an unrelated shift.
- The production audit reports zero resolved punch links outside their shift working window.
- Time Maintenance is installed with the canonical occurrence shift as its displayed Shift/Site/Post source.

## Validation

- Added regression coverage for overnight session ownership, invalid stored links, unambiguous historical repair, live punch routing, attendance totals, Time Maintenance display, and source-punch immutability.
- Full validation passed: type checking, lint, 70 test files / 356 tests, and the production build.
- Applied targeted production migrations:
  - `20260824224500_authoritative_overnight_occurrence_resolution.sql`
  - `20260824230000_time_maintenance_canonical_occurrence_display.sql`
- This was a database-only production correction; no Worker redeployment was required.
