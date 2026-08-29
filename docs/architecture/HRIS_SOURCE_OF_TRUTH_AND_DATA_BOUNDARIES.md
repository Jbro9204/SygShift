# HRIS Source of Truth and Data Boundaries

**Effective:** 08/29/2026

## Core rule

One person has one permanent SygShift employee identity. HRIS modules add effective-dated records and connected workflows to that identity. They must not create a second employee directory, second account record, second credential record, second schedule, second punch ledger, or second payroll calculation.

## Domain ownership

| Domain | Authoritative owner | HRIS may | HRIS must not |
| --- | --- | --- | --- |
| Permanent person identity | `public.employees` | Reference `employee_id`; propose controlled legal-name corrections | Create a separate HR person row representing the same worker |
| Account and authentication | User Accounts, private employee-account records, Supabase Auth | Display status and deep-link to authorized account actions | Store passwords, factors, recovery secrets, or duplicate usernames |
| Effective permissions | Roles & Permissions effective-access services | Request approved role or permission changes through existing services | Infer access from job titles, departments, or HR visibility |
| Contact information | Existing employee and private contact services | Display or request controlled updates | Copy sensitive contact data into workflow payloads or logs |
| Employment history | Future effective-dated HR employee record | Own manager, department, position, classification, status, and compensation history after Stage 2 | Rewrite historical schedule, payroll, licensing, or time evidence |
| Schedule and availability | Schedule, Scheduler, and Availability | Read availability and approved leave; create approved integration requests | Publish, modify, or remove shifts outside current schedule services |
| Time and attendance | Time & Attendance append-only events and corrections | Create approved leave/time categories through a versioned integration | Edit or delete original punches or recalculate worked time independently |
| Licensing and eligibility | Licensing Center | Read current status, assign onboarding tasks, deep-link to licensing profile | Copy credentials into an HR-only credential table |
| Training | Existing training/version/assignment records | Extend training workflows using existing course identity | Create duplicate course completions disconnected from eligibility |
| Payroll | Dedicated Payroll workspace and locked export records | Supply approved, versioned HR inputs only after Stage 10 contract | Replace calculations, unlock snapshots, or silently change pay results |
| Documents | Future HR document platform plus existing domain-specific buckets | Store each document only in its authorized vault | Put medical, identity, financial, or discipline records in general buckets |
| Notifications | Announcement/work-item/outbox/Worker delivery services | Submit minimal, approved work items | Put restricted HR details or documents into email content |
| Audit | `private.audit_events` and domain append-only histories | Add explicit HR business actions and protected read/export events | Update or delete audit history |

## Identifier rules

- `employee_id` is the stable cross-module worker identifier.
- Auth user IDs remain private implementation identifiers and are never used as employee identity in HR workflows.
- Stage 2 may introduce immutable person, worker, employment, assignment, department, position, and document IDs, but each worker must reconcile to one existing `employee_id`.
- External-system identifiers are namespaced, unique per source, and never allowed to replace the SygShift identifier.
- A candidate becomes an employee through an audited conversion that links to the permanent employee record. It is not implemented by copying the candidate into a second directory.

## Effective-dated change rules

Employment status, manager, department, position, classification, and compensation changes are effective-dated. A new decision closes the prior effective range and creates a new history row; it does not overwrite the prior decision. Retroactive changes require recent MFA, an explanation, explicit authorization, conflict validation, and an audit record.

## Cross-domain command rules

1. A module reads from the authoritative domain through a controlled service or permission-safe view.
2. A module never writes another domain's tables directly from the browser.
3. A cross-domain mutation is a versioned command with an idempotency key, actor, reason, effective date, validation result, and audit event.
4. The receiving domain may accept, reject, or hold the command for human approval.
5. Failures remain visible in an Action Center work item; they are not silently retried forever.
6. Payroll-impacting changes require an approved Stage 10 contract and never bypass locked payroll evidence.

## Separation and retention

Separation changes access and current operational visibility but does not erase the employee identity or protected history. Rehire attaches a new effective employment period to the same employee identity after duplicate review. Legal or policy-approved deletion applies to eligible records only and never removes records required for payroll, licensing, safety, audit, or legal retention.

## Migration acceptance

Every migration or backfill must produce:

- counts before and after;
- a duplicate-identity report;
- unresolved source mappings;
- referential-integrity results;
- permission and RLS test evidence;
- a rollback or forward-repair procedure;
- confirmation that current role memberships and person-specific permissions are unchanged.

No unresolved identity mismatch may be auto-promoted into the HR employee record.
