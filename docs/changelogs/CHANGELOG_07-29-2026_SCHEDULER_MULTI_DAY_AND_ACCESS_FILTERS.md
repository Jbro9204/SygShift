# SygShift Change Log - 07/29/2026

## Scheduler

- Added multi-day manual shift creation inside the Add Shift/Event workflow.
- Schedulers can now select the first date, enable multi-day creation, choose weekdays within the visible schedule week, and publish all selected dates in one action.
- The publish button now shows exactly how many open or assigned shifts will be created.
- The modal now closes automatically after a successful publish so the schedule refresh is clear and the workflow does not feel stuck.
- Existing schedule validation stays in place because each selected date uses the same production save path as a normal single-day shift.

## Users & Access

- Added an Activity filter using real account state:
  - All activity
  - Pending setup
  - Activated
  - Has signed in
  - Never signed in
- Reworked the Users & Access toolbar so filters and buttons are separated into a stable grid/action layout.
- Updated the button-layout guard test so future updates protect the new four-filter plus action-button layout.

## Future Items

- Synced the Future Items file in both the Git repo and Desktop folder.
- Marked Employee Time & Attendance self-view as completed.
- Marked account activity filters and multi-day manual shift creation as completed.
- Preserved Accountability Tracker as a pinned future item with HR-safe requirements.
- Preserved email-delivery filter tracking as a real future dependency that requires persisted send timestamps before UI filtering is added.

## QA

- TypeScript compile passed.
- Lint passed.
- Full test suite passed: 104 tests.
- Production build passed.
