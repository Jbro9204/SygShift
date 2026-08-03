# SygShift Change Log — 08/03/2026

## Schedule week copy integrity

### Reported issue

Copying a schedule week could leave the destination showing an older, incomplete schedule. Several sites from the source week were absent even though the interface appeared to move to the destination week.

### Root cause

The previous workflow merged shifts into an existing destination draft. Existing blocks were skipped without reconciling their assignments, while new assigned blocks could encounter credential validation partway through the operation. A failed transaction then left the prior destination schedule visible, which made the copy appear partially successful even though no copy audit was recorded.

### Changes

- The copy action now uses the exact schedule revision visible to the scheduler.
- The destination working draft is replaced instead of merged.
- The source schedule is never modified.
- The copy is atomic: every shift and eligible assignment must be written and verified or the destination remains unchanged.
- Source and destination block counts and assignment counts are verified before commit.
- Active assignments are carried forward; inactive or separated assignments are left open and counted for review.
- Existing armed placements without a currently valid uploaded credential are carried forward with an explicit audited credential override.
- The copy dialog now explains that the destination draft will be replaced and requires confirmation before the action is enabled.
- The completion message reports copied shifts, sites, assignments, credential overrides, and any inactive assignments left open.

### Production verification

- The production database function was installed and its signature verified.
- A full production transaction simulation copied the 08/02/2026 source revision into the 08/09/2026 destination and then rolled back without changing live schedule data.
- The simulation verified 136 shift blocks across 15 sites and 135 assignments.
- The simulation also verified 15 carried credential overrides and no inactive assignments.
- Type checking passed.
- Lint passed with warnings denied.
- All 160 automated tests passed.
- The production build passed.

### Scheduler workflow

1. Open the completed source week.
2. Select **Copy week**.
3. Choose the destination Sunday.
4. Choose whether to carry assignments and one-time events.
5. Confirm that the destination working draft will be replaced.
6. Select **Copy into draft**.
7. Review the copied destination and publish only when it is ready.

