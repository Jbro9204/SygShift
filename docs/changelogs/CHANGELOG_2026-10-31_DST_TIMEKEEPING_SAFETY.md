# Daylight-saving scheduling and manual time safeguards

Date: 10/31/2026. Status: verified source candidate; deployment is a separate gate.

## Protected contracts

Server-authoritative clock-in/out, break/resume, early-clock checks, punch/correction audit history, published schedules and payroll calculations remain unchanged. No DST database migration or source-data adjustment is included. Never add a blanket hour or substitute scheduled hours for actual work.

A read-only installed-helper probe using synthetic timestamps returned 540 elapsed minutes for Colorado 10/31 10 p.m. MDT to 11/01 6 a.m. MST, allocated 120 + 420 across the existing Denver Sunday-midnight boundary. The checked-in helper also verifies spring, repeated-hour breaks and effective adjusted punches. A bounded latest-published scan found nine crossing shift blocks; stored offsets/durations do not prove every scheduler's intent or a future live punch outcome.

## Changes

- Schedule create/edit/repeat shows endpoint offsets and elapsed duration. Ambiguous endpoints require actor/snapshot-bound acknowledgment of the backend-supported later standard-time occurrence; date/time/zone/date-list/account changes invalidate acknowledgment.
- Existing second-occurrence schedule edits preserve UTC meaning. An unrepresentable first-occurrence shift is stopped before mutation rather than moved. First-occurrence schedule creation remains an explicit backend limitation; no false option is offered. Week copy retains local-calendar semantics with a truthful DST notice.
- Manual entries, adjustments and employee/supervisor correction requests require first/second occurrence selection for ambiguous new input. Skipped spring times fail clearly before an API write.
- Unchanged original corrections and scheduled endpoint recommendations retain their exact instant, fold and precision. Recommendations display in the same Mountain basis as the Time Maintenance controls; manual/context changes clear retained evidence. Midnight uses 00:00, not invalid 24:00.
- Submissions capture employee/shift/post/zone/values/warning state before queuing, with pending-control and duplicate-submit guards. Live server clock routes do not use the manual-entry resolver.
- Payroll regressions cover 13-hour fall and 11-hour spring shifts, repeated-hour breaks, adjusted punches, device-zone independence and adjacent allocation/export reconciliation. A quoted-CSV test parser was corrected; production export arithmetic was not changed.

## Shared release baseline

The reviewed tracked v2 ownership baseline records the already-applied Sygilant receipt migration `20261031194837`: 440 entries, all previous 439 unchanged. This is a read-only baseline refresh, not a new migration, history-equivalence declaration or bulk replay. Existing reconciliation exceptions remain visible; both retry-safety manifests retain reviewed fingerprints.

## Verification, policy and fallback

Focused helper/full-form/account-change/delayed-mutation/correction/payroll tests, TypeScript and scoped lint pass. The exact candidate still requires full `release:verify`, mandatory desktop/mobile clock tests, exact-SHA GitHub checks, a fresh production build, committed database baseline and rollback-protected promotion. A missing authenticated canary is not a passed test; the documented anonymous fallback requires explicit operator approval. No committed real-employee test punches are authorized.

Preserve payroll-batch-v2's Denver Sunday-midnight rule. Finance/legal must separately confirm the documented workweek anchor/DST interpretation: federal guidance describes 168 fixed hours while local calendar weeks can span 167/169. This repair does not declare the existing policy illegal or silently change it. DOL: https://webapps.dol.gov/elaws/whd/flsa/otcalc/glossary.asp?p=workweek and https://webapps.dol.gov/elaws/whd/FLSA/hoursworked/screenEr11.asp.

If a verified application regression requires rollback, use the exact prior version and retain the installed database and all operational history. Do not change timezones, rates, shifts, punches, locked exports or payroll submission state to clear a display issue.
