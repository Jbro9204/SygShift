# SygShift Time Event Operational Shift Integrity

Date: 08/24/2026

## Outcome

Overnight punches now remain attached to the operational shift on which the employee began work. Gaston Musambay's 08/13/2026 6:00 PM clock-in now pairs with the 08/14/2026 6:00 AM clock-out as the 08/13/2026 workday.

## Root cause

The manual-punch workflow offered every published or draft shift whose time interval touched the selected calendar date. On 08/13/2026, this included both the overnight shift that ended that morning and the overnight shift that started that evening. The 6:00 PM clock-in was saved against the prior operational shift, so later processing correctly followed the stored shift identity but displayed the wrong workday.

## Correction

- Added an explicit operational date to Time Maintenance shift choices.
- Limited the manual-punch Site/Post selector to shifts that begin on the selected operational workday.
- Added a database validation boundary that rejects a new manual punch when the selected shift is outside the punch's permitted working window.
- Added append-only occurrence overrides for correcting an operational shift relationship without deleting or rewriting the original punch.
- Applied an audited occurrence correction to the confirmed 08/13/2026 punch.

## Record integrity

- No original time event was deleted or updated.
- The correction stores the original shift, replacement shift, reason, source, creator, and timestamp.
- Existing Site/Post display corrections remain separate from occurrence and payroll identity.
- The incorrect selection cannot recur through the standard Time Maintenance interface, and direct database requests receive a clear validation error.

## Production verification

- 08/12/2026 6:00 PM clock-in and 08/13/2026 6:00 AM clock-out share the 08/12/2026 occurrence.
- 08/13/2026 6:00 PM clock-in and 08/14/2026 6:00 AM clock-out share the 08/13/2026 occurrence.
- The production occurrence override exists once and is append-only.
- The operational-date field and manual-punch time-window guard are installed in production.

## Validation

- Added regression coverage for operational-date filtering, append-only corrections, the database time-window guard, and the confirmed production repair.
- Full validation passed: type checking, lint, 69 test files / 351 tests, and the production build.
- Applied targeted production migration `20260824213000_time_event_operational_shift_integrity.sql`.
- Deployed Cloudflare Worker version `76f367b7-1c8d-44f4-a17e-bde2b14525f1`.
