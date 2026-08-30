# HRIS Stage 2 — Core Data Architecture

Date: 08/29/2026

## Scope of this run

This document records **Stage 2, Run 1 of 3**. The run installs the dormant Core HR data contract. It does not backfill protected employee records, assign HR permissions to any role or employee, or expose an HR workspace to the browser.

## Authoritative identity

`public.employees` remains the permanent and authoritative SygShift employee identity. Existing employee UUIDs continue to connect Schedule, Time & Attendance, Payroll, Licensing, User Accounts, Roles & Permissions, Availability, and audit history.

The new private identity records extend that permanent identity:

- `private.hr_person_identifiers` maps exactly one HR person identifier to one existing employee UUID.
- `private.hr_worker_identifiers` maps exactly one worker identifier to one HR person identifier.
- Neither table duplicates legal names, preferred names, email addresses, phone numbers, authentication identities, or employee numbers.
- Employee numbers remain business identifiers; they do not replace the permanent UUID primary key.

This design prevents a second employee directory and makes future HR modules join back to the records SygShift already uses.

## Reference records

The following private reference tables provide controlled HR structure:

- Legal entities
- Organization units, including divisions, departments, teams, and cost centers
- Work locations linked optionally to existing SygShift sites
- Job profiles
- Positions

Reference records cannot be deleted. They may be deactivated or superseded so historical assignments remain explainable.

## Effective-dated history

The following private tables preserve employment history:

- Employment relationships: employer, status, worker classification, employment type, and effective dates
- Assignments: position, department, cost center, location, assignment type, and effective dates
- Manager relationships: direct, matrix, or functional manager history
- Employment changes: hire, rehire, transfer, promotion, classification, leave, return, separation, and corrections
- Compensation changes: component, amount, currency, pay basis, standard weekly hours, and effective dates

Effective records are close-only. After insertion, an existing record may only receive a valid end date, closing timestamp, responsible employee, and required reason. Other changes require a new effective-dated record. Overlapping employment, primary-assignment, same-type manager, and same-component compensation records are rejected.

## Security boundary

- All Stage 2 records live in the private schema.
- Row-level security is enabled on every new table.
- Direct access is revoked from `public`, `anon`, and `authenticated` roles.
- The service role is the only runtime principal granted table access in this run.
- Every mutation is written through the existing append-only audit mechanism.
- Identity and employment-change records are append-only.
- Historical and reference records cannot be deleted.
- Self-manager relationships are rejected.

Six HR permission definitions were registered for later controlled use. They were not granted to any role or employee:

- `hr.people.view`
- `hr.people.manage`
- `hr.people.restricted`
- `hr.total_rewards.view`
- `hr.total_rewards.manage`
- `hr.total_rewards.restricted`

## Release state

The machine-readable contract is `config/hris-core-data-architecture.json`.

The following controls remain false:

- HR feature enabled
- Protected production backfill allowed
- HR role mapping allowed
- Direct browser access allowed

The Stage 1 protected-data gate also remains closed. Current roles, role memberships, individual permission grants, individual denials, login access, and employee statuses are unchanged.

## Reconciliation

Two service-only database functions support later controlled runs:

- `private.hris_core_reconciliation_report()` returns counts only and identifies unresolved or invalid mappings without exposing PII.
- `private.assert_hris_core_integrity()` rejects duplicate employee mappings and orphan worker identities.

Run 2 must generate and review a proposed active/historical employee mapping before any protected record is inserted. Run 3 must perform the controlled backfill, reconciliation, authorization tests, recovery evidence, and canary validation before the Stage 2 gate may open.
