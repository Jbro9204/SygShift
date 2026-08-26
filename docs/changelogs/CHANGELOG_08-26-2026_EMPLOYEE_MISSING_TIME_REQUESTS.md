# SygShift Change Log — Employee Missing-Time Requests

Date: 08/26/2026

## Summary

Added a controlled self-service workflow for employees to report an entire worked shift that is missing from SygShift.

## Employee Workflow

- Added **Request missing time** to **My Time**.
- The employee is identified automatically from the signed-in account and cannot select another employee.
- The request collects:
  - Work date
  - Clock-in time
  - Clock-out time
  - Site/Post
  - Unpaid break minutes
  - Required explanation
- The employee sees a clear notice that submitting the request does not create punches or payroll hours.
- Submitted requests remain visible to the employee with their current review status.
- Pending requests remain visible across prior pay periods for up to one year, including requests for recently completed payroll periods.

## Review Workflow

- Authorized reviewers can open the request in Time Operations.
- Reviewers can place the request under review, approve it, or reject it.
- Approval requires the existing time-adjustment review permission and verified MFA.
- The reviewer must provide a decision note.
- Approval creates an audited clock-in and clock-out pair.
- When an unpaid break is provided, approval also creates the audited break events.
- Rejection and under-review actions do not create payable time.
- Existing-punch and unusually long-shift warnings require explicit reviewer confirmation.

## Payroll and Audit Safeguards

- Employee submission creates no time event and no payable time.
- Payroll changes only after authorized approval.
- Original request values, employee explanation, reviewer decision, reviewer identity, timestamps, and created event identifiers are retained.
- Duplicate pending requests for the same employee and time range are blocked.
- Site/Post, work date, duration, break length, and active-employment checks are enforced by the database.
- Public and anonymous database access is not granted.

## Validation

- Added dedicated regression tests covering identity derivation, submission isolation from payroll, review permissions, MFA enforcement, audit history, and approved event creation.
- Passed type checking and linting.
- Passed all 81 test files / 405 tests.
- Passed the production build.
- Applied and verified targeted production migration `20260826180000_employee_missing_time_requests.sql`.
- Verified all required database columns, RPC functions, migration history, and authenticated execution grants.
- Deployed Cloudflare production version `930c446f-1671-4e6e-a631-a0674335cd22`.
- Verified the custom domain, Worker health, Worker readiness, and the served production My Time bundle.
