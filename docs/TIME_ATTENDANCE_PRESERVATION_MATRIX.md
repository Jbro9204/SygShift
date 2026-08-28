# Time & Attendance Redesign Preservation Matrix

Date: 08/27/2026

This document is the pre-change inventory for the unified SygShift Time & Attendance workspace. It defines the workflows that must remain functional while the navigation and presentation layers are consolidated.

## Verified baseline

- Branch: `main`
- Baseline commit: `a4dceab`
- TypeScript, lint, production build, and the complete Vitest suite passed before implementation.
- Baseline test result: 88 test files and 451 tests passed.
- Payroll calculation, payroll export, and the `/time/payroll` workflow are explicitly outside this redesign.

## Route preservation

| Existing route | Current purpose | Canonical destination after redesign | Preservation rule |
| --- | --- | --- | --- |
| `/time` | Time Command Center | Overview | Remains the main Time & Attendance entry point. |
| `/time/my-time` | Employee self-service | My Time | Preserved and shown as a workspace tab. |
| `/time/team` | Team attendance | Team | Preserved and shown as a workspace tab. |
| `/time/exceptions` | Payroll exceptions and correction requests | Review Queue | Preserved as a legacy deep link and routed to the correct Review Queue section. |
| `/time/daily-review` | Schedule/time reconciliation | Review Queue | Preserved as a legacy deep link and routed to Daily Reconciliation. |
| `/time/operations` | Missing starts, manual time, call-offs, and operational history | Operations | Preserved and shown as a workspace tab. |
| `/time/accountability` | Factual attendance occurrences | Accountability | Preserved and shown as a workspace tab. |
| `/time/tools` | Legacy combined time tools | Permission-aware canonical time area | Preserved as a legacy deep link without duplicating the old interface. |
| `/time/payroll` | Payroll review and export | Payroll | Excluded from this redesign. |

## Workflow preservation

### Employee clock lifecycle

- Server-authoritative clock-in, break start, break end, and clock-out.
- Assigned-shift selection and unscheduled-time fallback.
- Duplicate-punch protection and immediate query-cache refresh.
- Existing clock sessions remain intact across navigation and deployment.
- Sick/call-off reporting and missing-time requests remain available.

### My Time

- Current pay-period hours and recent punch history.
- Employee correction requests without mutating the original record.
- Missing-time requests with employee identity supplied by the authenticated session.
- Existing pending-request and correction status visibility.

### Team

- Permission-protected team summary.
- Search/filter access to employees with time activity.
- Shared `TimeMaintenanceWorkbench` for punch creation, correction, Site/Post changes, work-type changes, and voiding.
- Original punch history and audit notes remain preserved.

### Review Queue

- Payroll exception review.
- Employee correction approval/decline.
- Daily schedule-versus-attendance reconciliation.
- Existing hard blockers stay non-overridable.
- Existing human-review findings retain approve, dismiss, reopen, and documented-reason controls.

### Operations

- Missing starts, manual time entry, call-off visibility, alert acknowledgment, and operational history.
- Existing supervisor/admin permission checks and audit behavior.

### Accountability

- Factual attendance occurrences remain separate from time punches.
- Accountability actions do not silently create, change, or delete payroll time.

## Data and authorization boundaries

| Concern | Existing source | Required behavior |
| --- | --- | --- |
| Session and effective permissions | `src/data/auth.ts` and server session context | Server authorization remains authoritative; tabs and links mirror, not replace, authorization. |
| Punches and review rows | `src/data/timekeeping.ts` | No replacement data model; existing APIs and audit-safe mutations are reused. |
| Operational alerts and manual time | `src/data/timeOperations.ts` | Existing APIs are reused from the Operations tab. |
| Accountability | `src/data/accountability.ts` | Existing APIs and permission checks are reused. |
| Time permissions | `src/time/timePermissions.ts` and route access policy | Each tab is permission-aware and inaccessible workflows are not exposed. |
| Payroll | Existing payroll pages and data functions | No behavioral, calculation, export, or route changes in this redesign. |

## UI and navigation guarantees

- Back navigation uses only verified in-app history and falls back to Home.
- Home remains a separate direct action.
- Route query state continues to carry date ranges, filters, selected employees, and review focus where already supported.
- The Time workspace uses one header, permission-aware tabs, and one persistent clock control.
- Existing full-page workflows are consolidated without copying their business logic.
- Modal saves continue to show busy state, close or refresh on success as appropriate, and display fresh server data.
- Mobile, tablet, and desktop layouts must not rely on a bottom-only horizontal scrollbar for primary actions.

## Rollback checkpoints

1. Inventory and preservation matrix.
2. Global Back/Home and collapsible grouped navigation.
3. Unified Time workspace and persistent clock control.
4. Overview and My Time consolidation.
5. Team and shared maintenance consolidation.
6. Review Queue, Operations, Accountability, and legacy route compatibility.
7. Production validation and deployment.

Every checkpoint must pass targeted tests before the next checkpoint and the complete repository check before production deployment.
