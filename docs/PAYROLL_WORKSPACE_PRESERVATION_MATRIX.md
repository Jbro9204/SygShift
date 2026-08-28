# Payroll Workspace Preservation Matrix

Last verified: 08/28/2026

This matrix is the release boundary for moving Payroll out of Time & Attendance. A workflow may be reorganized, but it may not be removed, duplicated, weakened, or made less auditable.

| Existing capability | Current implementation | Destination | Preservation requirement |
| --- | --- | --- | --- |
| Period selection | Payroll page date controls and payroll-rule shortcuts | Shared Payroll workspace header | One date range follows the user across every Payroll tab. Default is the current open period. |
| Payroll readiness | `getTimekeepingReview`, `payrollLockBlocker`, readiness metrics | Overview | Same server-calculated status and blocking rules. |
| Blocker correction | Payroll blocker modal and `TimeMaintenanceWorkbench` | Review Queue | Reuse the canonical correction workflow; do not create a second punch editor. |
| Correction approvals | `reviewTimeEventCorrection` | Review Queue | Keep MFA, permission checks, audit note, and immediate refresh. |
| Exception resolution | Existing timekeeping exception and resolution APIs | Review Queue | Preserve hard versus reviewable blocker behavior and resolution history. |
| Payroll batch assignment | `correctPayrollBatchAssignment` | Review Queue issue detail | Keep exact occurrence fingerprint, Sunday validation, MFA, and required audit reason. |
| Employee weekly totals | `summarizePayrollWorkbookByWeek` | Employee Payroll | Keep Sunday-Saturday weeks and entire overnight occurrence in the week where it begins. |
| Employee detail | Weekly summary selection and punch rows | Employee Payroll detail | Open on demand; do not render every punch in the all-employee view. |
| Preview workbook | `downloadPayrollWorkbook` preview | Export & History | Preserve workbook validation and error reporting before download. |
| Official lock | `createPayrollExportBatch` | Export & History | Preserve blocking validation, required note, immutable batch record, and audit history. |
| Locked downloads | `getPayrollExportBatchDetail` | Export & History | Preserve exact locked data and accountability context. |
| Export history | `getPayrollExportHistory` | Export & History | Searchable/paginated presentation may change; records remain append-only. |
| Accountability items | `getPayrollAccountabilityEvents` | Overview, Review Queue, workbook | Keep sick, call-off, PTO, and related pay context in calculations and exports. |
| Payroll rules | `getPayrollRules` and existing server rules | Rules | Admin-only editing; effective-dated and audited. Read-only summary remains available where useful. |
| Time & Attendance team list | Team Attendance expandable employee list | Time & Attendance | Remains operational; compact, paginated, and focused on attendance rather than payroll export. |
| Permissions and MFA | Existing Time/Payroll permission helpers and server RPC checks | Every Payroll route/action | No new broad permission. Navigation and routes must mirror effective server access. |
| Legacy links | `/time/payroll`, `/time/rules` | `/payroll/export`, `/payroll/rules` | Redirect with query parameters preserved. No dead bookmarks. |

## Release invariants

- No payroll tables or production records are deleted or rewritten for this redesign.
- No role or individual permission assignment is changed.
- Preview and official exports continue to contain only SygShift worked-time records plus approved accountability/pay categories.
- Payroll calculations remain server-authoritative; browser sorting, filtering, and pagination never change totals.
- Every mutation retains loading, success/error feedback, audit behavior, and data refresh.
- Legacy Payroll URLs remain valid through redirects.
