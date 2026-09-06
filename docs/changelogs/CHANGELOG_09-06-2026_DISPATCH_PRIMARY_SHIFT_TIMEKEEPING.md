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
- A post-migration database lint caught two composite-row loads in new Scheduler helper functions before web deployment. A second forward-only migration corrected them, completed a linked rollback rehearsal, and added a regression guard.
- Type checking, zero-warning lint, production builds, and all 171 Vitest files / 821 tests passed.
- All 118 desktop and mobile Playwright checks passed, including the new Dispatch mode layout and the existing timekeeping, Scheduler, and responsive-layout coverage.
- Applied production migrations `20260906154620_dispatch_primary_shift_timekeeping.sql` and `20260906160934_repair_dispatch_scheduler_composite_loads.sql`; both are recorded in migration history.
- Production verification found Michael's four published September 6–9 Dispatch shifts stored as standard paid shifts with no physical-post overlap. Zero current/future standalone Dispatch shifts remain incorrectly classified as concurrent duty.
- Under Michael's authenticated employee identity, the live Timekeeping RPC returned his current Dispatch assignment as an eligible standard shift. No test punch was created, and the migration preservation check left all 1,004 historical time events unchanged.
- Both new Scheduler helpers passed production database lint and runtime execution. The edit-path test ran inside a rolled-back transaction and did not change a schedule.
- Deployed Cloudflare Worker version `37594341-ffdd-4b28-96eb-b992c31bc8a2`; health, readiness, `/schedule`, and the deployed primary/concurrent Dispatch controls all passed live verification.
