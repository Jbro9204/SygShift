+# SygShift Change Log — 08-03-2026

## Controlled employee removal

- Added a protected Admin-only employee removal workflow in Users & Access.
- Removal requires:
  - the employee to be separated;
  - Admin access with MFA;
  - a written removal reason;
  - typing the employee username exactly.
- The confirmation window now shows linked shift, time, request, and credential counts before removal.
- Removed employees disappear from working user and licensing lists.
- Login access, remembered devices, roles, and individual permission overrides are disabled.
- Payroll, schedule, licensing, and audit references are retained so historical records remain accurate.
- Recently Deleted retains the removal snapshot for 14 days.

## One-time directory cleanup

Removed from the working system:

- PATROL BREAK
- Test Employee
- Test Tester

Lucius Corliss was intentionally retained as a separated employee.

## Licensing Center

- Renamed Compliance to Status.
- Renamed Eligibility and Work Eligibility to Shift Eligibility.
- Grouped standard and armed guard credentials under Guard Licenses.
- Clarified the two records as Standard Guard License and Armed Guard License / Endorsement.
- Updated filter and table labels to match the new terminology.

## Quality verification

- Production database migration applied directly and recorded as version 20260803173000.
- Live database verified that only the three approved test/non-employee records were removed.
- Live database verified that Lucius Corliss remains untouched.
- Type checking passed.
- Lint passed with warnings denied.
- 159 automated tests passed.
- Production build passed.

