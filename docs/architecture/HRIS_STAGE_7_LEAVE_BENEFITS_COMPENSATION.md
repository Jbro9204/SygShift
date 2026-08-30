# HRIS Stage 7 — Leave, Benefits, and Compensation Architecture

**Architecture date:** 08/30/2026  
**Production posture:** Installed and dormant

## Purpose

Stage 7 adds protected foundations for leave administration, benefits administration, and compensation history without replacing SygShift's existing operational time-off, Schedule, Time & Attendance, Payroll, employee identity, document vault, or access-control systems.

Each Stage 7 workspace has two independent release boundaries: a private database gate and a Worker feature flag. All are disabled by default. The release creates no policy, balance, entitlement, benefit promise, enrollment, compensation decision, role assignment, or employee permission override.

## Leave administration boundary

Operational employee time-off remains authoritative in `public.time_off_requests`. Stage 7 leave cases link to those requests rather than duplicating them. The private leave foundation includes:

- effective-dated policy definitions that require approved source material;
- leave cases linked to the employee and, when applicable, the operational time-off request;
- explicit downstream authorizations before Schedule, Time & Attendance, or Payroll treatment can be applied;
- restricted protected-leave records with a separate permission boundary;
- optional links to exact private document-vault records;
- append-only leave events.

An approved leave case does not silently alter a schedule, punch, payroll row, balance, or entitlement. Each downstream action requires its own documented authorization and must use the authoritative module responsible for that data.

## Protected leave boundary

General leave access does not expose medical or other protected details. Those records require the separate `hr.leave.protected.view` or `hr.leave.protected.manage` permission. Protected attachments remain in the private HR document vault and are referenced by identifier; Stage 7 does not create a second document store.

## Benefits administration boundary

The benefits foundation supports:

- plan definitions and immutable effective-dated plan versions;
- coverage tiers;
- explicit eligibility rules;
- enrollment windows;
- employee enrollment decisions;
- dependent and beneficiary records;
- append-only benefit events.

The schema is ready to hold approved plan information, but the release intentionally contains no invented carrier, plan, eligibility, premium, coverage, dependent, beneficiary, or enrollment data.

## Compensation boundary

The compensation foundation supports:

- grades and effective-dated bands;
- compensation components;
- effective-dated employee compensation history;
- proposed changes and documented decisions;
- append-only approval and compensation events.

Compensation access requires the exact effective permission and recent MFA. A proposal cannot be approved by its proposer. That separation is enforced at the database boundary in addition to the service layer. Stage 7 contains no compensation mutation route while the workspace is dormant, and deployment creates no grade, band, component, employee compensation record, proposal, or approval.

## Security model

- Stage 7 operational tables are in the private schema with row-level security enabled.
- Browser roles have no direct table or service-RPC access.
- Worker routes require an active authenticated employee and the exact view permission.
- Protected leave permissions are separate from general leave permissions.
- Compensation access requires recent MFA.
- Compensation proposal and approval authority are separate, and self-approval is rejected by the database.
- Event histories and compensation approvals are append-only.
- Lists are bounded to 5, 10, or 20 rows per page.
- No Stage 7 permission is assigned to an existing role or employee by the migration.
- Existing employees, accounts, roles, permission assignments, schedules, time records, payroll records, licensing records, operational time-off requests, and audit history remain authoritative and unchanged.

## Activation boundary

Stage 7 must not be activated during an ordinary deployment. Each module may be activated independently only after:

1. the business owner supplies approved source policy or plan data;
2. intended permissions are reviewed and approved by name;
3. recovery and rollback evidence is current;
4. a canary record is validated without inventing employee information;
5. protected-data access is tested with authorized and unauthorized accounts;
6. compensation recent-MFA and two-person approval controls are exercised;
7. downstream leave behavior is confirmed to require explicit authorization;
8. audit, mobile, accessibility, pagination, and failure-state checks pass;
9. the applicable database gate and Worker flag are deliberately enabled;
10. production monitoring confirms unrelated modules and access assignments remain unchanged.

## Rollback posture

The immediate rollback is to disable the affected Worker flag and database gate and remove only the Stage 7 permissions granted during activation. Additive schema objects and all audit evidence remain in place. A rollback must not delete or rewrite leave, benefit, compensation, approval, or protected-record history.
