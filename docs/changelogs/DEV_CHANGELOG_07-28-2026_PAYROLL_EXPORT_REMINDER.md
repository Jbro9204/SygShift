# SygShift Dev Changelog - 07/28/2026

## Update focus

Weekly payroll export reminder for Admins and Supervisors.

## Completed

- Added a role-aware payroll export reminder across the protected SygShift workspace.
- The reminder appears for Admin and Supervisor accounts only.
- The reminder links directly to Time & Attendance so payroll review/export is one click away.
- The reminder automatically calculates the last fully closed Sunday-through-Saturday payroll week.
- Reminder dates display in the required U.S. format: MM/DD/YYYY.
- Added high-visibility sticky banner styling that stays professional and usable across desktop and mobile.
- Added reduced-motion/mobile behavior so the reminder remains readable on phones.
- Added regression tests for:
  - last completed payroll week calculation,
  - Admin/Supervisor-only reminder visibility.

## QA completed

- TypeScript typecheck passed.
- Lint passed.
- Unit/integration tests passed: 25 test files, 84 tests.
- Production build passed.
- Playwright E2E passed: 16/16 desktop and mobile checks.
- Deployed smoke check passed: `https://app.sygilant.us` returned HTTP 200.

## Deployment

- Production URL: https://app.sygilant.us
- Worker URL: https://sygshift.sygilant.workers.dev
- Cloudflare Worker version: `828d4e23-d61e-49c0-86fa-c67643e13af6`

## Forward-looking note

This is the right direction for the platform: reminders, roles, operational rules, and workflow controls should move into Admin-facing UI over time so routine business changes do not require code changes.
