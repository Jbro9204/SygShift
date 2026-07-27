# SygShift Dev Changelog — 07/27/2026

## Update: Roles & Permissions UI Rework

### What changed

- Reworked the `Roles & Permissions` page into a centered command-center layout.
- Removed the always-visible create-role form from the main page.
- Added a `Create role` button that opens a dedicated role creation window.
- Added permission nests inside the create-role window:
  - Administration
  - Schedule
  - Scheduler
  - Directory
  - Availability
  - Sites & Posts
  - Time & Attendance
  - Announcements
  - Reports
  - Licensing
  - Other permission groups from the live catalog
- Rebuilt role editing so permissions are organized under expandable category nests instead of a flat wall of cards.
- Added cleaner role tiles with permission count and assigned-person count.
- Hid the employee access editor from the bottom of the page.
- Added a deliberate `Manage employee access` flow:
  - Open employee chooser window.
  - Search active employees.
  - Choose a person.
  - Open that employee’s access editor only when needed.
- Kept the per-person editor available for:
  - Extra role memberships.
  - Individual permission grants.
  - Individual permission denies.
  - Effective permission preview.
- Added responsive styling so the page collapses cleanly on smaller screens.

### QA completed

- TypeScript check passed.
- Lint check passed.
- Unit test suite passed: 23 files, 79 tests.
- Production build passed.
- Cloudflare deployment completed.
- Production health endpoint passed.
- Production readiness endpoint passed.

### Live deployment

- Production URL: `https://app.sygilant.us`
- Cloudflare version: `ccbbbd03-4f29-4287-b009-af9540aebb5f`
