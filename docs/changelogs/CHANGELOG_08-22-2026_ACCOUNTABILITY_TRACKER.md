# SygShift Change Log — Accountability Tracker

Date: 08/22/2026

## Summary

SygShift now includes a controlled Accountability Tracker for documenting and reviewing real attendance occurrences without changing valid punches, weakening payroll controls, or turning protected leave into a negative reliability record.

## Operational workflow

- Authorized users open **Time & Attendance → Accountability Tracker** from the Time Command Center.
- Late arrivals, early departures, no-call/no-show events, and other factual occurrences can be recorded against an active employee.
- Shift-based occurrences must be attached to a published shift assigned to that employee.
- Sick reports and call-offs remain in Time Operations. Approved time off remains in Time-Off Requests.
- Authorized reviewers can confirm an occurrence, mark it excused/protected, mark it corrected, dismiss an incorrect record, void it, or reopen it.
- Every decision requires a reason. The record shows who acted, what they chose, and when they acted.

## Review context

The review window shows the employee, occurrence type, location, original factual note, scheduled shift, actual worked time, worked segments, unpaid gaps, schedule variance, rules requiring review, and complete decision history.

Approving an occurrence does not merge punches, invent worked time, remove unpaid gaps, or alter the original schedule. Hard timekeeping blockers remain actionable only in Time Exceptions.

## Reliability safeguards

- Only reviewed and confirmed call-offs, no-call/no-show events, late arrivals, and early departures count as confirmed reliability occurrences.
- Protected sick time, vacation, excused/protected events, corrected events, dismissed events, voided events, and unresolved reports do not count negatively.
- An approval applies only to the specific occurrence. It does not disable a validation rule for the employee or company.

## Security and audit controls

- Viewing requires `accountability.view` or `accountability.manage` with MFA.
- Creating requires `accountability.create` with MFA.
- Reviewing requires `accountability.manage` with MFA.
- Decisions are stored in append-only history with actor, timestamp, reason, and before/after record state.
- Original punch and schedule records remain unchanged.
- Production access preservation was verified after the migration: 47 active employee access records, 6 roles, and 64 permission definitions matched exactly.

## Timekeeping guardrail

The missing-clock-in grace period is 14 hours after scheduled start. This supports 12-hour operations while retaining a meaningful exception for a truly missing clock-in.

## Validation

- Targeted production migration applied and recorded: `20260822143000_accountability_tracker_workspace.sql`.
- Live MFA-authorized database workspace check passed with 47 active employees and 144 eligible published shift assignments in the sampled range.
- Type checking passed.
- Lint passed with warnings denied.
- Automated tests passed: 58 files / 308 tests.
- Production build passed.
- Production health and readiness checks passed after deployment.
- The protected Accountability Tracker route correctly redirects unauthenticated sessions to sign-in.
- Deployed Cloudflare Worker version `f3a8c659-8836-4034-b9a5-14f71636fd59`.
