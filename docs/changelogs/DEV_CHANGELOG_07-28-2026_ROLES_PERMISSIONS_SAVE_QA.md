# SygShift Dev Changelog - 07/28/2026

## Update focus

Roles & Permissions save reliability, button polish, and full save-function QA.

## Completed

- Fixed the Roles & Permissions database save blocker that showed `Protected Admin permissions cannot be removed` when editing non-admin roles.
- Kept the safety rule for the real Admin role only, so Admin cannot accidentally lose the core protected permissions while still allowing Admins to add or remove permissions on other roles.
- Added and applied a production repair migration for `public.set_access_role_permissions`.
- Verified the live Supabase function now checks `target_role.code = 'system_admin'` before enforcing protected Admin permission rules.
- Verified the live function no longer references the missing `private.audit_log` table and uses the correct `private.audit_events` audit target.
- Audited the frontend save/RPC surface against the live database:
  - confirmed save functions exist,
  - confirmed authenticated users have execute rights where required,
  - confirmed no checked save function references `private.audit_log`,
  - confirmed no save-function failures were returned by the audit query.
- Reworked Roles & Permissions action buttons so `Create role`, `Save permissions`, employee access actions, and modal actions use one local uniform button system.
- Added regression coverage to prevent generic button styling from slipping back into Roles & Permissions.
- Added database regression tests for the protected Admin permission guard.
- Fixed the E2E static server so route `/` serves `index.html` instead of attempting to download the build directory.
- Updated E2E expectations for the renamed `Directory` page.
- Kept the Roles & Permissions protected/unavailable state inside a proper page shell with a visible page heading for accessibility.

## QA completed

- TypeScript typecheck passed.
- Lint passed.
- Unit/integration tests passed: 24 test files, 81 tests.
- Production build passed.
- Playwright E2E passed: 16/16 desktop and mobile checks.
- Deployed smoke check passed: `https://app.sygilant.us` returned HTTP 200.

## Deployment

- Production URL: https://app.sygilant.us
- Worker URL: https://sygshift.sygilant.workers.dev
- Cloudflare Worker version: `e750a94b-41d8-4757-be14-afb1966e171e`

## Notes

- Existing unrelated Git status items were left untouched:
  - deleted legacy docs,
  - `.pnpm-store/`,
  - `.reference/`,
  - `assets/`.
