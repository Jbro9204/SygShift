# Licensing Credential Removal — September 15, 2026

## Outcome

Authorized Licensing Center users can now remove a credential from a person's active licensing profile without deleting the credential, its documents, or its history. Removed credentials are kept in a clearly labeled section on that employee's profile and can be restored when appropriate.

## What changed

- Added **Remove from profile** to the existing credential-management dialog.
- Added a short confirmation that identifies the employee and credential, explains the effect, and requires a plain-language removal reason.
- Added the reasons **Added to the wrong employee**, **Duplicate credential**, **Entered by mistake**, **No longer applicable**, and **Other**. Other requires an explanation.
- Removed credentials immediately leave active eligibility and reporting calculations. If the credential type is required, the profile correctly returns to **Missing**.
- Added a collapsed **Removed credentials** section that shows the removal time, actor, reason, and retained document count.
- Added **Restore** for authorized users. Restore is stopped when another active credential of the same type already exists, preventing a duplicate active record.
- Added responsive light/dark presentation rules so the confirmation, history card, and actions remain rounded, evenly spaced, readable, and contained on desktop and mobile.

## Data integrity and security

- This workflow archives and restores the same credential row; it never hard-deletes a credential.
- Attached credential documents and their relationships remain intact through removal and restore.
- Archive metadata records the actor, time, reason code, and supporting detail.
- Both lifecycle actions write before-and-after evidence to the private audit log.
- Database functions enforce the existing credential-editor permission and MFA boundary, use a fixed empty search path, and are unavailable to anonymous callers.
- A partial uniqueness boundary prevents multiple active credentials of the same type while still permitting retained archived history.
- No employee, credential, document, schedule, shift, punch, payroll, request, notification, or access record was deleted or rewritten during release verification.

## Verification

- Focused lifecycle checks passed: **3 files / 11 tests**.
- Focused desktop/mobile light/dark browser checks passed **8/8**, including containment, control sizing, and zero Axe violations.
- Full repository gate passed: **260 test files / 1,325 tests**, TypeScript, zero-warning application lint, Worker build, and client production build.
- Full browser matrix passed: **336 passed / 12 intentional skips / 0 failures** across desktop and mobile.
- Production rollback-only database verification passed archive, required-credential recalculation, retained-document, audit, authorization, restore, and duplicate-conflict scenarios, then rolled back every fixture.
- Production database security and performance advisors returned **zero error-level findings**.
- Post-release actual-component Time Clock preservation passed **42/42** across desktop and mobile.
- Both production origins returned HTTP `200` with health `ok` and readiness `ready`; every reported dependency check passed.
- The live Licensing Center bundle, shared stylesheet, and main application bundle matched the final production build byte-for-byte on both origins.
- Signed-out `/licensing` checks on both origins redirected to `/login` and exposed no credential content.

## Release references

- Source commit: `6cca7ff`
- Database migration: `20260915151039_licensing_credential_archive_restore.sql`
- Cloudflare Worker version: `676b05a2-7039-4587-81ca-032fef31a0ab`
- Rollback tag: `rollback/pre-licensing-credential-removal-20260915`
- Primary URL: `https://app.sygilant.us`
- Fallback URL: `https://sygshift.sygilant.workers.dev`

## Files

- `src/pages/LicensingCenterPage.tsx`
- `src/data/licensing.ts`
- `src/App.css`
- `supabase/migrations/20260915151039_licensing_credential_archive_restore.sql`
- `supabase/tests/licensing_credential_archive_restore_regression.sql`
- `src/licensingCredentialLifecycleGuard.test.ts`
- `tests/e2e/licensing-credential-removal-layout.spec.ts`
