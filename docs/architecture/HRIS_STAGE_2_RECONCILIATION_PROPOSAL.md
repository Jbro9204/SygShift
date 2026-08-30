# HRIS Stage 2 Reconciliation Proposal

Date: 08/29/2026

## Purpose

Stage 2 Run 2 prepares a deterministic one-to-one mapping from the permanent `public.employees.id` identity to the dormant HR person and worker identifiers. It is a proposal and validation layer only. It does not write protected HR mappings or activate an HR feature.

## Identity rules

- `public.employees.id` remains the authoritative employee identity.
- A versioned SHA-256-derived UUID proposes one HR person identifier and one HR worker identifier per employee UUID.
- The internal worker reference is derived from the employee UUID and contains no name, email address, phone number, username, or authentication identifier.
- Legal names, preferred names, contacts, authentication records, and profile data are not copied into the HR identity tables.
- Current and historical employees are both included so separated history can remain connected without reactivating a separated person.

## Blocking conditions

The proposal stops before backfill when it finds any of these conflicts:

- an employee already points to a different person identifier;
- an existing person mapping records a different source employee;
- a proposed person UUID is occupied by another employee;
- an existing person points to a different worker identifier;
- an existing worker mapping records a different person;
- a proposed worker UUID is occupied by another person;
- a proposed worker reference is occupied by another person.

Missing employee numbers, hire dates, or separation dates are review warnings. They do not create a second identity and therefore do not silently block the identity proposal, but they must be reviewed before effective-dated employment history is generated.

## Data exposure

The detailed proposal is available only to the server service role. Browser roles cannot execute it. The aggregate summary contains counts only and never includes employee names, employee numbers, contact details, usernames, or authentication identifiers.

## Closed gate

Successful reconciliation means only that the proposal has no identity collision. It does not authorize production backfill. Protected backfill, role mapping, browser access, and HR runtime features remain disabled until Stage 2 Run 3 completes recovery evidence, authorization tests, canary validation, and cross-module preservation checks.
