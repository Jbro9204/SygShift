# Attendance, Dispatch history, and employee pay-period review

Date: 09/06/2026

## Problems and corrections

- Older standalone Dispatch blocks retained the concurrent classification on replacement schedule revisions. Earlier punches remained attached to superseded shifts. Corrected eligible historical standalone blocks, preserved original punches, and blocked duplicate clock-ins across equivalent revisions in both backend entry paths. Missed-punch monitoring now recognizes the preserved earlier-revision clock-in; automatic clock-out still closes the original session.
- Attendance cards showed only open/confirmed/protected/reliability counts, hiding the meaning of corrected records. Cards now show recorded absences, late arrivals, early departures, and other/time-off counts alongside all review-state counts. Corrected records remain recorded; dismissed/voided records are excluded from type totals. Confirmed reliability remains separate.
- Three explicit call-off notes from the reported week were incorrectly classified as Other. Reclassified only those exact documented call-offs, with audit records and existing review outcomes retained. An ambiguous accident note remains Other pending an authorized factual review.
- Added a reason-required, audited correction of occurrence type. It does not change notes, review outcomes, schedules, punches, or payroll, and does not send a new call-off notification.
- Attendance & Call-Offs now uses the same canonical native/legacy/time-off sources as the tracker. Added date/type/review/search filters, Sunday–Saturday week shortcuts, compact pagination, and complete Excel/CSV exports. Excel includes employee summary and occurrence detail; CSV neutralizes spreadsheet-formula text.
- My Time now offers current, previous, and two-periods-ago selections using server-defined payroll boundaries. Today/This Week remain current; selected-period rows/totals load independently. Mobile controls retain the existing design system.

## Changed areas

- `src/time/MyTimePage.tsx`, `accountability.ts`, `AccountabilityPage.tsx`; attendance/timekeeping data contracts.
- `src/reports/AttendanceReportWorkspace.tsx`, report/export helpers, Reports routing/catalog, and scoped styles.
- Forward migrations: `20260906162426_attendance_reporting_and_classification`, `20260906162427_employee_recent_pay_periods`, `20260906162428_historical_standalone_dispatch_timekeeping`.

## Verification and release

- Linked production rehearsal, fully rolled back: report/source parity, preserved decisions, export audit, classification audit, duplicate protection through both backend APIs, standalone historical Dispatch clock-in/automatic clock-out, paired manual entry, revision-aware automation, employee-only three-period reads, unauthorized access denials. No test shift, punch, notification, or classification was retained.
- Database function lint: zero errors or warnings for all new PL/pgSQL functions and the amended automation function.
- New regression tests cover actual My Time selection, current-day metric isolation, report filters and all-pages exports, factual versus decision totals, historical employee inclusion, CSV safety, Excel archive contents, and protected migration boundaries.
- Existing desktop/mobile browser suite: 118 passed.
- `pnpm check` passed: typecheck, zero-warning lint, 175 test files / 833 tests, and production build.
- All three forward migrations applied successfully in one transaction. Preservation hashes/counts verified unchanged: 1,004 punches, 258 corrections, 3 payroll export batches / 13 export rows, 78 employees, 68 employee accounts, 30,882 assignments, and 7 payroll batch assignments.
- Git push, Worker deployment, and authenticated live verification: pending release completion.

## Operational instructions

- Dispatch: use Primary paid shift for standalone paid Dispatch. Use Concurrent phone duty only alongside another paid shift. Correct existing timecards rather than creating duplicate time on republished blocks.
- Weekly OPS report: Communication → Reports → Attendance & Call-Offs → Previous week (or chosen From/Through) → retain All review states → Export Excel or Export CSV. Exports include all matching pages.
- Classification: Accountability Tracker → View occurrences → Review → Correct occurrence type → select type, explain, Save occurrence type. Review outcomes remain unchanged.
- Employee review: My Time → Your Hours → Pay period → Current period, Previous period, or Two periods ago. Contact Timekeeping about discrepancies before processing; historical views do not amend approved payroll.

## Deliberate limits

- Genuine concurrent phone duty remains non-payable as a second session. Existing punches/payroll are not duplicated or reassigned.
- The ambiguous accident record is not assumed to be an absence; an authorized reviewer must establish the facts.
- Attendance counts are occurrences, not absent days, payroll deductions, or discipline points. Historical timecard previews are not pay stubs.
