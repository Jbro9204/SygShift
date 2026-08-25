# SygShift Change Log — Maintenance Communications and Safe Release Controls

Date: 08/25/2026

## Purpose

Give SygShift a controlled, employee-visible maintenance process so releases can be communicated, affected workflows can be protected, and active work is not interrupted without warning.

## Changes

- Added an Admin-only, MFA-required **System Operations** workspace.
- Added scheduled, active, automatically expired, completed, and canceled maintenance states.
- Added notice-only, read-only, and temporarily unavailable access modes.
- Added feature-level scope so the Time Clock and other unaffected areas remain available during targeted work.
- Added global upcoming, active, and completion messages with Mountain Time start/end information.
- Added route-level unavailable states for selected features.
- Added database write enforcement across 50 operational tables for active read-only or unavailable windows.
- Added Worker/API maintenance checks for protected service operations.
- Added an active-save safeguard so a release refresh waits for in-progress mutations to finish.
- Added audited scheduling, editing, completion, and cancellation operations.
- Added an automatic end time and a 24-hour maximum so maintenance cannot remain enabled indefinitely.
- Added the operator runbook at `docs/operations/MAINTENANCE_RELEASE_RUNBOOK.md`.

## Security and Access

- Added critical permission `admin.maintenance.manage`.
- Granted the permission only to the protected System Admin role.
- MFA is required at the database boundary.
- Existing roles, additional role memberships, and individual permission overrides were not changed.
- A deployment cannot activate maintenance by itself.

## Production Database

- Applied migration `20260825190000_maintenance_release_controls.sql`.
- Confirmed the migration is recorded in linked Supabase migration history.
- Confirmed one permission definition and one System Admin grant.
- Confirmed 50 protected operational tables.
- Confirmed zero maintenance windows and no active, upcoming, or completed notice after migration.

## Quality Assurance

- Type checking passed.
- Lint passed with warnings denied.
- 381 automated tests passed across 75 test files.
- Production build passed.
- Added coverage for status parsing, admin operations, feature routing, Mountain Time conversion, and Worker/API enforcement.
- Verified whitespace and patch formatting with `git diff --check`.

## Release Verification

- Git release commit: `9a8544f` (`Add maintenance communications and safe release controls`).
- Cloudflare Worker version: `72c2abe7-d505-4ed1-b279-cb057e6aed35`.
- Confirmed `https://app.sygilant.us/api/v1/health` returns HTTP 200 with an `ok` status.
- Confirmed `https://app.sygilant.us/api/v1/ready` returns HTTP 200 with all required bindings ready.
- Confirmed the protected System Operations route redirects a signed-out browser to Login.
- Verified the live public shell at 1280 × 720 and 390 × 844 with no horizontal overflow or browser console warnings/errors.
- Confirmed zero active maintenance windows after deployment. Normal production access remains in effect.
