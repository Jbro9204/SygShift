# HR Suite Operational Release — 09/03/2026

## Outcome

Released the remaining in-system HR workspaces from read-only staged foundations into permission-controlled operational tools. Recruiting, Leave, Benefits, Talent, Learning, Employee Cases, Safety, Assets, Offboarding & Rehire, HR Self-Service, and HR Reporting now join the already operational People, Employee File, Onboarding, Compensation, and Document Studio areas.

## What changed

- Added one centralized HR action interface with consistent, responsive forms for the protected modules.
- Added a service-only database action boundary and a matching Cloudflare Worker endpoint.
- Enforced exact action permissions at both Worker and database layers.
- Retained recent MFA for Employee Cases, Safety, Offboarding, and Reporting.
- Retained independent maker-checker approval for leave decisions, benefit-plan activation, and lifecycle decisions.
- Added audited actions for recruiting requisitions and applicants and operational actions for each released HR workspace.
- Repaired latent Stage 6 query ambiguities in onboarding task creation, pre-hire duplicate-email checking, and candidate conversion.

## Data and access safety

- The migration captured and rechecked employee, role-assignment, permission-override, and protected HR record counts before committing.
- No employee, applicant, leave, benefit, talent, learning, case, safety, asset, lifecycle, request, report, pay, schedule, time, licensing, document, or access record was created by the release.
- Browser roles cannot execute the service routines directly; only the service role can execute them.
- Existing Human Resources Employee, Human Resources Manager, and Admin permission assignments were preserved.
- HR automation and external payroll/iSolved integration gates remain closed.

## Verification

- Forward migration compiled successfully against production inside a forced rollback.
- Supabase schema lint was run; the three HR release defects identified by the analyzer were repaired in this migration. Unrelated and dormant-module findings were not hidden or broadened into this release.
- Production release gates were verified enabled for all 11 newly released modules.
- Post-migration counts confirmed zero new protected HR business records.
- TypeScript, zero-warning application lint, focused release guards, the full automated suite, and the production build were run before deployment.

## Remaining separately controlled work

- Historical HR identity backfill still requires authoritative employment dates and recovery evidence.
- General-purpose HR automation remains gated until approved workflow content and a dedicated canary exist.
- External payroll/iSolved integration, webhooks, and enterprise cutover remain gated.
- Advanced Document Studio capabilities such as OCR, native PDF editing, irreversible redaction, external signers, and organizational seals remain separate future releases.
