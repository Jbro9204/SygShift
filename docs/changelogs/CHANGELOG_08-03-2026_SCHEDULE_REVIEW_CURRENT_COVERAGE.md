# SygShift Change Log — 08/03/2026

## Schedule Review Resolution Repair

### Issue corrected

Schedule review items could remain marked **Review needed** even after an active employee was assigned and the shift was fully covered. Attempting to resolve the item then failed because the database tried to add another assignment to a shift whose required headcount was already satisfied.

This was visible on PERA-Denver armed shifts where the historical imported assignee was Ryvon and the current assignment was Fernando Gomez.

### Production changes

- Added a protected database path that recognizes when the selected employee is already assigned to the shift.
- Covered shifts can now be approved without adding a duplicate assignment.
- Current active coverage is retained exactly as scheduled.
- The original imported assignee and source context remain in the shift history for audit purposes.
- Terminated historical employees are not reactivated or reassigned.
- If a different employee is chosen while the shift is already full, the scheduler receives clear instructions to confirm a current assignee or use the shift editor to replace coverage.
- Schedule revision creation is serialized by week to reduce competing revision-number conflicts.
- Existing assignment override records are carried into the new revision.
- The shift open/covered state is recalculated after resolution.
- The resolver now records whether current coverage was retained in its result.

### User interface changes

- The resolution window now identifies the current assigned coverage.
- A covered review item explains that no additional employee is needed.
- The currently assigned employee is selected automatically.
- The primary action reads **Approve current coverage** when the existing assignment will be retained.
- The completion message confirms that coverage was approved and that the original import name remains in history.

### Verification completed

- TypeScript type check passed.
- Lint passed with warnings denied.
- 32 test files passed.
- 155 automated tests passed.
- Production build passed.
- Cloudflare deployment dry run passed.
- A production database transaction test was run against the live Ryvon/Fernando shift. It successfully created a new schedule revision, retained Fernando, reported the retained assignment, and was rolled back without changing the schedule.
- The database procedure was installed successfully.
- The application was deployed to Cloudflare.
- Live login-page smoke test passed with no browser console errors.

### Production location

https://app.sygilant.us

