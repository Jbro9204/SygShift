# Dispatch Primary Shift Timekeeping Repair

**Released:** September 6, 2026

## What was found

- Dispatch Phone Coverage had been treated as concurrent, non-payable duty in every case. That classification was too broad: it also covered employees, including Michael Hinz, whose Dispatch assignment was their primary paid shift.
- Michael's four published Dispatch shifts for September 6–9 had no overlapping standard post but were marked as concurrent duty, so the Scheduler displayed them while Timekeeping correctly refused to offer a separate clock session for that stored type.
- Michael's earlier Dispatch shifts were standard paid shifts and had normal web clock-ins and automatic clock-outs, confirming that account access and the general clock workflow were not the cause.

## Repair

- Added an explicit Scheduler choice for **Primary paid shift** and **Concurrent phone duty** whenever Dispatch Phone Coverage is selected.
- Primary paid Dispatch shifts now participate in employee clock-in, missed-punch review, automatic clock-out, scheduled overtime, and payroll like any other standard shift.
- Concurrent Dispatch duty retains the existing protection against duplicate payable clock sessions when the employee is already working a physical post.
- Preserved the selected mode through creation, editing, duplication, partial-week copying, week copying, overtime preview, and publication.
- Corrected current and future standalone Dispatch assignments to primary paid shifts. Assignments with a genuine overlapping standard physical post remain concurrent duty.
- Preserved historical time events, schedule revisions, audit records, employee access, and payroll history.

## Verification

- The production migration completed a full linked rehearsal inside a transaction that was rolled back; its preservation assertions and reclassification logic passed.
- Type checking, zero-warning lint, production builds, and all 171 Vitest files / 820 tests passed.
- All 118 desktop and mobile Playwright checks passed, including the new Dispatch mode layout and the existing timekeeping, Scheduler, and responsive-layout coverage.
- Production migration, database verification, Worker deployment, live health/readiness, and deployed-asset verification are recorded below when completed.

