# SygShift Change Log — 08/16/2026

## Attendance Review Coverage Consolidation

Daily Attendance Review now presents one operational review item for one actual coverage window. Repeated underlying schedule slots no longer produce separate cards for the same Site/Post, date, and time.

### What changed

- Groups identical coverage slots within the same published schedule by Site/Post or event, start time, end time, time zone, and armed requirement.
- Shows one combined review card with the required headcount, scheduled employees, actual employees, recorded work, unpaid gaps, call-offs, and discrepancy rules.
- Deduplicates repeated copies of the same scheduled employee so an accidental duplicate does not inflate a 1-person shift into a 2-person requirement.
- Retains legitimately different employees assigned to the same window and represents them together under the consolidated occurrence.
- Resolves and audits the combined occurrence through one canonical shift identifier and a fingerprint of the complete current record.

### Data integrity

- No published shifts were deleted or rewritten.
- No employee assignments, punches, corrections, worked segments, unpaid gaps, or call-offs were deleted or rewritten.
- Every underlying shift ID remains attached to the consolidated review snapshot.
- A source change produces a new fingerprint so a prior decision cannot silently clear changed schedule or time data.

### Production verification

- Applied targeted production migration `20260816170000_attendance_review_coverage_grouping.sql`.
- Confirmed the reported MG Properties Patrol and Neon Local repeated groups now calculate as one scheduled employee for one required position.
- Confirmed the private grouping function and both public review functions are installed with the required security-definer behavior.
- Full validation passed: type checking, lint, 45 test files / 219 tests, and production build.

### User impact

Authorized reviewers should refresh Daily Attendance Review. Repeated cards for the same coverage window will appear once, while the full employee and time detail remains available inside the review.
