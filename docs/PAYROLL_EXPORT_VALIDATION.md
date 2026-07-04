# Payroll export validation

Payroll validation is the proof that SygShift is not just tracking time, but tracking payable time correctly.

## Payroll standard

Every exported payroll row must be explainable from approved SygShift records:

- employee
- date
- site, post, event, or shift
- clock-in time
- clock-out time
- total payable time
- break or unpaid adjustment when applicable
- regular time
- overtime time
- manual correction reason
- approving supervisor or admin when approval is required

If a paid hour cannot be explained, it is not ready for payroll.

## Required checks before first payroll use

### 1. Employee identity

Confirm:

- each active employee has one active login
- every login is connected to the correct employee
- username is unique
- role is correct
- employment type is correct
- armed qualification is correct where relevant

### 2. Schedule connection

Confirm time entries can be tied back to:

- scheduled shifts
- open shifts accepted by guards
- events accepted by guards
- supervisor-created schedule changes
- manually approved exceptions

Time entries that are not tied to a known work item should be flagged for supervisor review.

### 3. Time-zone handling

SygShift stores authoritative timestamps on the server and displays operating times in the business time zone.

For this operation:

- admins may be in North Carolina
- guards and supervisors may be in Colorado
- payroll review should use the configured operating time zone, not the viewer's laptop time zone

During validation, compare at least five entries from different devices to ensure the displayed work date and time match the Colorado operating schedule.

### 4. Exception coverage

Test and approve handling for:

- early clock-in
- late clock-in
- missed clock-out
- clocking into the wrong site
- supervisor correction
- cancelled shift
- open shift accepted after announcement
- event shift
- armed-only shift
- unarmed guard attempting to take armed work
- overnight shift crossing midnight
- overtime threshold
- salary employee day marker

### 5. Export review

Before payroll accepts the first export:

1. Export one pilot week.
2. Pick at least ten employees or all pilot employees, whichever is smaller.
3. Compare SygShift exported hours against the approved timekeeping screen.
4. Confirm overtime math with the payroll reviewer.
5. Confirm the receiving payroll system can open and process the file.
6. Keep the test export out of Git and source control.

## Payroll dry-run checklist

Use this checklist for each payroll dry run:

- All time entries for the pay period are closed.
- No active employee has an open clock session from the pay period.
- Missed punches are resolved.
- Manual corrections include a reason.
- Corrections show who made them.
- Approved time-off is visible where payroll needs it.
- Overtime is separated or clearly marked.
- Salary employee day markers are visible when needed.
- Export totals match review-screen totals.
- Payroll reviewer signs off before the export is used.

## Launch rule

SygShift should not become the source for live payroll until a dry run proves:

- the export can be read by payroll,
- all pilot hours can be explained,
- exception handling is understood,
- no unexplained overtime appears,
- and supervisors know how to correct errors before export.

This protects the company and the employees.
