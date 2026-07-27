# SygShift Dev Changelog — Recruiting & Licensing Center

Date: July 27, 2026
Production URL: https://app.sygilant.us

## What changed

- Added the new `Recruiting & Licensing` system role.
- Added the `Onboarding` employee status so new hires can be tracked before they are fully active.
- Added a new protected sidebar section: `Licensing Center`.
- Built the Licensing Center dashboard for administrators and Recruiting & Licensing Coordinators.
- Added red / yellow / green compliance visibility for credential records.
- Added dashboard counts for:
  - fully compliant employees
  - credentials expiring within 90 / 60 / 30 days
  - expired credentials
  - missing required credentials
  - awaiting review
  - rejected credentials
  - renewals in progress
  - employees whose work eligibility is restricted by credential issues
- Added searchable/filterable credential records by employee, credential type, compliance status, and employment status.
- Added employee licensing profiles with credential cards, credential status, renewal state, document counts, notes, expiration dates, and work eligibility.
- Added credential editing from the Licensing Center.
- Added credential document upload support through the existing protected Supabase credential document bucket.
- Added communication history recording for licensing reminders and credential follow-ups.
- Added approved licensing email template records for:
  - 90-day reminders
  - 60-day warnings
  - 30-day final warnings
  - missing/rejected credential notices
- Added configurable credential type and credential requirement tables so future requirements can be changed in data instead of being hard-coded in the app.
- Backfilled existing employee credential rows to the new credential type system.
- Updated the existing Directory credential editor permission check so Recruiting & Licensing can update credentials without receiving admin-level access.
- Updated UI role labels and employee status handling across auth, admin, workforce, scheduling, requests, announcements, opportunities, and worker-side schemas.

## Security and access

- `Recruiting & Licensing` is not treated as admin.
- The new role can view/manage licensing records and record licensing communication.
- The new role does not receive payroll, billing, user-admin, or unrestricted admin privileges.
- Licensing Center access requires MFA.
- Credential document storage remains private and now allows credential-document access only for MFA-verified licensing/admin/supervisor-qualified users.
- New licensing tables have row-level security enabled and are accessed through controlled RPC functions.
- Changes are recorded through audit events for employee profile, credential, document, and communication actions.

## Database work completed

- Added migration `20260727192500_recruiting_licensing_enums.sql`.
- Added migration `20260727193000_recruiting_licensing_center.sql`.
- Created/updated:
  - `role_permissions`
  - `credential_types`
  - `credential_requirements`
  - `employee_credential_documents`
  - `licensing_communications`
  - `licensing_email_templates`
  - `employee_work_eligibility_overrides`
  - `employee_credentials` extensions for credential type, renewal status, employee notes, rejection details, and archival
- Added RPC functions:
  - `get_licensing_center`
  - `upsert_licensing_employee`
  - `upsert_licensing_credential`
  - `record_licensing_credential_document`
  - `record_licensing_communication`
  - licensing permission helpers

## QA completed

- TypeScript typecheck: passed.
- Lint: passed.
- Unit/integration test suite: 23 files passed, 79 tests passed.
- Production build: passed.
- Supabase migration applied successfully.
- Supabase schema cache refreshed.
- Cloudflare production deploy completed.
- Production health endpoint passed.
- Production readiness endpoint passed.

## Deployment

- Deployed to Cloudflare Workers.
- Current production custom domain: https://app.sygilant.us
- Worker deployment version: `c0b9a78e-bb52-43bf-9392-5bd3037a7908`

## Notes for the next phase

- The Licensing Center now has the data structure and protected workspace needed for licensing operations.
- Automated scheduled delivery of 90/60/30-day credential emails can be wired next using the approved template records and the existing email service.
- Scheduler hard enforcement can now read the new credential/work-eligibility model when deciding who is eligible, warning-only, or blocked for specific assignments.
