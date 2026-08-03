# SygShift Change Log — 08/03/2026

## Scheduler employee-view navigation

- Added a dedicated horizontal schedule control directly above the Scheduler employee week board.
- Made the control remain available while the scheduler moves vertically through a long employee schedule.
- Synchronized the upper control with the weekly board in both directions, so moving either scrollbar keeps the other at the same position.
- Preserved the full Sunday-through-Saturday board and the scheduler's current vertical position while viewing later days.
- Hid the redundant control at the single-column mobile breakpoint, where horizontal scrolling is not required.
- Expanded resize tracking so the control recalculates when schedule cards or board contents change.

## Quality checks

- Added a scheduler behavior guard test covering the synchronized employee-view scrollbar.
- Type checking passed.
- Lint passed with no warnings.
- All 156 automated tests passed.
- Production build passed.

