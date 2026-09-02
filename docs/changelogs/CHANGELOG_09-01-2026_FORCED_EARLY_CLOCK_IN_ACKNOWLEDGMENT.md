# Forced Early Clock-In Acknowledgment

Date: 09/01/2026  
Status: Released to production

> Superseded on 09/02/2026 by the server-driven production restriction documented in `CHANGELOG_09-02-2026_PRODUCTION_EARLY_CLOCK_IN_RESTRICTION.md`. The replacement covers every clock-in surface and does not depend on a client-side time check.

## Outcome

An employee who selects **Clock In** before the approved clock-in window now receives a prominent red warning dialog on both Home and My Time. The dialog must be explicitly acknowledged before it closes.

## Employee experience

- The early Clock In action remains visible instead of appearing disabled or redirecting without explanation.
- The warning says: **Your shift does not start for _X hours/minutes_.**
- It also shows the scheduled start time, Site/Post, and explains that clock-in opens five minutes before the shift.
- The dialog has no close icon.
- Escape does not close it.
- The employee must select **I understand**.
- The layout is responsive and the acknowledgment button expands to full width on small screens.

## Safety boundaries

- The authoritative server clock-in rule remains unchanged and continues to reject punches earlier than five minutes before the published assigned shift.
- The update does not alter schedules, assignments, punches, overnight workday ownership, time-card history, or payroll calculations.
- Existing dialogs remain dismissible by default; the non-dismissible behavior is opt-in and used for this acknowledgment warning.

## Verification

- Type checking passed.
- Lint passed with zero warnings.
- 127 test files and 634 tests passed.
- Worker and client production builds passed.
- Wrangler deployment dry run passed.
- Deployed Worker version: `a783fbe6-65ef-4234-aa08-43e9cddd2518`.
- The production login page loaded with the new release and no browser console errors.
