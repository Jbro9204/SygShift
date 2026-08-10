# SygShift Change Log — 08/10/2026

## Timekeeping Exception Resolution

### Business outcome

- Added a controlled exception-resolution workflow for legitimate time patterns that require human judgment.
- Administrators no longer need to delete or alter valid punches to clear a reviewable payroll blocker.
- Original punches, worked segments, unpaid gaps, scheduled-shift context, and resolution history remain preserved.
- An approval applies only to the exact occurrence reviewed. A later punch change creates a new occurrence that must be reviewed again.

### Administrator workflow

- Open a blocker from Time Exceptions and review the employee, date, scheduled shift, actual worked time, unpaid gaps, and the rule that created the finding.
- View the complete punch timeline and each calculated work segment.
- Choose one of four outcomes:
  - Correct the punches through the existing audited maintenance workflow.
  - Approve the occurrence as a valid exception.
  - Dismiss a finding that was generated incorrectly.
  - Leave the finding unresolved.
- Approval and dismissal require an explanatory reason.
- The system records the decision, resolver, timestamp, reason, finding, and occurrence fingerprint.

### Reviewable findings

- Multiple valid work segments during one scheduled shift.
- Unscheduled work that has been reviewed and confirmed.
- Authorized schedule deviations.
- Work performed across more than one valid location.

### Hard payroll blockers

The following conditions remain non-overridable because they cannot produce a reliable payroll result:

- Missing clock-in or clock-out.
- Impossible or invalid punch ordering.
- Pending employee correction requests.
- Completed activity that calculates to zero paid minutes.

### Medical-appointment scenario

- A clock-in, mid-shift clock-out, later clock-in, and final clock-out are treated as two separate worked segments.
- Only the completed worked segments count toward payroll.
- The time between the middle clock-out and later clock-in remains an unpaid gap.
- Approving the exception confirms that the pattern is legitimate; it does not merge punches, invent time, or modify the original record.

### Security and audit controls

- Added the `time.resolve_exceptions` permission.
- Resolution requires an MFA-verified session and the dedicated permission.
- Resolution records are append-only and protected by row-level security.
- Direct record mutation is blocked; all decisions flow through the controlled database function.
- Every resolution writes to the central audit log.

### Payroll and exports

- Approved valid exceptions and dismissed false positives no longer block payroll for that exact occurrence.
- Hard blockers continue to prevent payroll readiness.
- Payroll workbooks now include an **Exception Decisions** worksheet with the finding, action, reason, resolver, timestamp, and occurrence identifier.
- Original punch data remains unchanged in payroll detail and audit history.

### Quality verification

- Database migration compiled and applied successfully to production Supabase.
- TypeScript typecheck passed.
- Lint passed with warnings denied.
- 176 automated tests passed across 37 test files.
- 16 desktop and mobile browser tests passed.
- Production build passed.
- Cloudflare production deployment completed successfully.
- Production Worker version: `0603c105-2abe-4546-a9f1-cccf1f862e1a`.
