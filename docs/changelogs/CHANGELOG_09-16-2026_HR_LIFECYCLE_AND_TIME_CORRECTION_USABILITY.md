# 09/16/2026 - HR Lifecycle and Time Correction Usability

## Outcome

The Employee Lifecycle case wizard now behaves like an actual employee picker, the lifecycle page actions sit in a deliberate toolbar instead of crowding the status cards, and employee time-correction cards identify the person whose record is being reviewed.

## Changes

- Replaced the disconnected employee search plus hidden dropdown behavior with one guided employee picker.
- Added visible matching results for name, username, and employee-number searches.
- Automatically selects a unique or exact eligible match while refusing to guess when multiple employees match.
- Added a clear selected-employee confirmation with name, username, employee number, and a **Change** action.
- Kept lifecycle eligibility intact: active employees remain available for separation workflows and separated employees remain available for rehire.
- Repaired the search icon collision by protecting the required left input padding from the later shared modal-control rule that previously overrode it.
- Added a dedicated responsive lifecycle action toolbar so **Start guided case**, **Export view**, and **Refresh** remain evenly sized and separated from the KPI cards.
- Added employee name and username to both pending punch-correction and missing-time request cards.
- Preserved the existing correction reasons, requested times, statuses, audit history, and protected review workflows.

## Safety and scope

- No database migration, production-data rewrite, employee-status change, access change, schedule change, punch mutation, or payroll change was required.
- HR authorization, maker-checker approval, final human confirmation, MFA, and lifecycle eligibility rules were not changed.
- Time-correction records remain append-only and continue to use the existing protected review workflow.
- The changes are presentation and selection behavior only.

## Verification

- Focused component and guard suite passed: 4 files and 20 tests.
- Full `pnpm check` passed: 266 test files and 1,341 tests, strict TypeScript, zero-warning lint, and production build.
- Focused desktop/mobile Playwright passed 8/8 checks, including search-icon clearance, action-toolbar separation, correction identity, responsive layout, accessibility, and zero horizontal overflow.
- Required actual-component Time Clock regression passed 42/42 desktop/mobile checks.
- Visual inspection confirmed the desktop and mobile layouts remain evenly cushioned, rounded, readable, and aligned.

## Release

- No database migration is required.
- Production deployment details are recorded after release.
