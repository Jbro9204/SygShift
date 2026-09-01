# Action Center History

## Release summary

SygShift now separates active Action Center work from completed history. Employees see clear **Needs Attention**, **In Progress**, and **History** views. Completed records leave the active queue immediately but remain available as immutable, searchable audit history.

## What changed

- Added a three-view Action Center workspace:
  - **Needs Attention** for new, assigned, pending, and overdue actions.
  - **In Progress** for actions the employee has opened but not completed.
  - **History** for acknowledged, completed, superseded, cancelled, and expired outcomes.
- Corrected `get_employee_action_center()` so terminal announcement, training, and schedule records are no longer returned as active work.
- Added `get_employee_action_history(...)`, a protected paginated query that reads the existing authoritative sources directly:
  - announcement acknowledgments;
  - training assignments and attestations;
  - schedule acknowledgment snapshots;
  - HR workflow tasks.
- No duplicate history table or copied employee record was created.

## History workspace

- Defaults to 10 records with compact 5/10/20 pagination.
- Supports search by employee, title, original details, resolution note, resolver, and record context.
- Supports filters for action type, outcome, resolved-from date, and resolved-through date.
- Employees can review their own history with `actions.self.view`.
- MFA-verified authorized users can switch to **Authorized team history**. Each source remains protected by its own management permission:
  - `announcements.acknowledgments.manage`;
  - `training.manage`;
  - `schedule.acknowledgments.manage`;
  - `hr.automation.manage`.
- Holding one management permission does not expose records from another source.

## Read-only audit details

Each history row opens a read-only detail modal containing:

- employee;
- action type and outcome;
- assigned, viewed, due, and resolved timestamps;
- resolver and employee/manager/system resolution source;
- original description or instructions;
- completion or resolution note;
- schedule revision, shift count, and applicable site/post information.

Historical records cannot be edited or reopened in place. A future correction must create a new linked action so the original outcome is not silently rewritten.

## Preservation and security

- Forward migration `20260902080000_action_center_history.sql` changes protected functions only.
- Migration assertions confirmed that no announcement acknowledgment, training assignment, schedule acknowledgment, HR workflow task, employee-role assignment, or permission override was changed.
- Production counts remained unchanged after migration: 693 schedule acknowledgment records, 0 announcement acknowledgment records, 0 training assignments, 0 HR workflow tasks, 1 employee-role assignment, and 0 individual permission overrides.
- Team history requires current MFA plus the exact source-management permission.
- Direct table access remains revoked; history continues through the security-definer boundary.

## Validation

- Full `pnpm check` passed:
  - type checking;
  - zero-warning lint;
  - 146 test files / 707 tests;
  - Worker build;
  - client build.
- Full browser QA passed: 62 desktop/mobile checks.
- Verified light and dark modes, responsive containment, keyboard-readable controls, accessibility scanning, filters, 10-row default pagination, disabled pagination states, and read-only details.
- A live authenticated production smoke test returned page 1 with 10 of 24 preserved schedule-history records for the selected employee.
- A live active-queue smoke test confirmed that only pending/viewed, assigned/in-progress/overdue, and pending/viewed states are returned.

## Production rollout

- Implementation commit: `57a2d78`.
- Migration applied and reconciled: `20260902080000`.
- Cloudflare Worker version: `9dd4d714-f1df-4f8f-bcdf-cb16f80c7f3c`.
- Primary and fallback login, health, and readiness endpoints returned `200`.
- The live Action Center asset contains the three views, protected history RPC, and read-only audit detail workflow.

No authentication rule, role assignment, employee profile, schedule record, timekeeping record, payroll behavior, or HR workflow was changed by this release.
