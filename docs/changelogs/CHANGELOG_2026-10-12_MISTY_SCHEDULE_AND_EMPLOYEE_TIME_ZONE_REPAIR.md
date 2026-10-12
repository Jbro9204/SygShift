# Misty Schedule and Employee Time-Zone Repair

Date: October 12, 2026

## Outcome

- Corrected Misty Kimbal's October 12 timecard from the erroneous 3:00 PM Eastern system auto-clock-out to the authorized 5:00 PM Eastern end time.
- Preserved the original 3:00 PM auto-clock-out and the correction reason in the audit history.
- Verified the corrected day totals 8.00 worked hours from the existing 9:00 AM Eastern web clock-in through 5:00 PM Eastern.
- Corrected and published Misty's Monday-through-Friday schedule for October 12-16 to 9:00 AM-5:00 PM in Employee Time - Eastern.
- Published only Misty's schedule so unrelated employees and coverage blocks were not changed.

## Application Repair

- Employee-facing My Time dates, punch timestamps, pending corrections, timecard windows, attendance shift choices, and correction inputs now use the employee profile time zone.
- The clock-in shift selector now renders scheduled times in the employee profile time zone even when the site has a different local time zone.
- Correction requests convert the employee-entered local date and time back to the correct UTC instant before submission.
- Shift identity remains authoritative when matching a punch to a timecard row, including near-midnight cross-zone cases.

## Preserved Behavior

- Stored schedule and punch instants remain UTC.
- Payroll periods, Sunday workweek boundaries, review/lock/export behavior, and payroll calculations remain governed by the existing America/Denver payroll configuration.
- Automatic clock-out continues to use the authoritative stored shift end instant.
- No database schema or data migration was required.

## Verification

- Employee-zone regression coverage includes Eastern display, day grouping, correction prefill and UTC round-trip, near-midnight matching, and employee-zone shift labels.
- Payroll and automatic-clock-out preservation tests remain part of the release gate.
- Production schedule and corrected timecard were verified in the authorized SygShift admin workspace.
