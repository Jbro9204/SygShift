# Document Studio Human Resources Access Boundary

Date: 09/02/2026

## Outcome

The complete Document Studio is now restricted to **Admin**, **Human Resources Manager**, and **Human Resources Employee** by default. Any other employee requires an explicit grant of the exact `documents.workspace.view` permission before the workspace, its routes, or its management APIs become available.

Every signed-in employee retains a separate **My Documents** workspace for records assigned specifically to that employee. My Documents no longer contains the HR forms library and does not expose employee files, templates, processing, policies, signature administration, or the protected document vault.

## Enforcement

- Navigation displays **Document Studio** only when the current session contains `documents.workspace.view`; the public employee link is now **My Documents**.
- Both Document Studio routes require the same exact permission. Employee-file and onboarding deep links use that route boundary as well.
- Every Worker endpoint that manages the library, vault, requests, assignments, templates, workflows, signatures, policies, or processing verifies the exact permission before MFA and before calling the database.
- Employee self-service endpoints remain separate and continue to return only the caller's assigned requests, signature actions, previews, downloads, and completed records.
- PostgreSQL now rechecks `documents.workspace.view` inside the Document Studio and legacy HR document helpers. The template catalog implementation is private, while its service wrapper is executable only by the service role after the employee permission check.
- Direct browser execution remains unavailable to `anon` and `authenticated` database roles.

## Data preservation

- Migration `20260903020750_restrict_document_studio_to_hr.sql` changed authorization functions only.
- It did not add, remove, or rewrite employee role assignments, individual permission overrides, documents, versions, requests, assignments, templates, signature envelopes, or recipients.
- The migration compared protected record counts plus role-permission and employee-override fingerprints before commit and would have failed closed on any difference.

## Verification

- Full release gate passed before deployment: TypeScript, zero-warning lint, 157 test files / 760 tests, and both production builds.
- Focused access-boundary tests passed 23/23.
- Focused Document Studio, HR library, and signature browser checks passed 12/12 across desktop and mobile Chromium in light and dark themes, with accessibility and overflow checks.
- The production database reports the exact default role set as Admin, Human Resources Manager, and Human Resources Employee.
- A rollback-only live database allow/deny drill confirmed an authorized employee is accepted and a representative employee without the exact permission is denied.
- Production and fallback application, health, and readiness endpoints returned HTTP 200; an anonymous request to the protected Document Studio API returned HTTP 401.

## Release status

- Implementation commit: `2f5b143`, pushed to `origin/main`.
- Test-alignment commit: `ba190d9`, pushed to `origin/main`.
- Production migration: `20260903020750`, applied and reconciled.
- Cloudflare Worker version: `5ce97fd2-b8d7-4e21-b530-187b78b5fbac`.

