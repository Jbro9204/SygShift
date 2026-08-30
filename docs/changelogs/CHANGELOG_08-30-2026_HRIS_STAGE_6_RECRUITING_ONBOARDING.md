# SygShift Change Log — 08/30/2026

## HRIS Stage 6: Recruiting and Onboarding Foundation

### Delivered

- Added a permission-controlled recruiting workspace for requisitions, candidates, interviews, scorecards, offers, and dispositions.
- Added duplicate-aware candidate conversion with a two-person approval requirement before a permanent employee record can be created.
- Added an onboarding workspace with reusable templates, dependent tasks, readiness tracking, reminders, and an auditable activity history.
- Connected onboarding readiness to the existing User Accounts, Licensing, Training, equipment, document, and site-access systems without duplicating those records.
- Added bounded 5, 10, and 20 item views so recruiting and onboarding worklists remain usable as records grow.
- Added server-side permission checks, private database tables, row-level security, append-only event history, and protected administrative endpoints.
- Added architecture and operations documentation, including activation, emergency-stop, rollback, and validation procedures.

### Production Safety

- Recruiting and Onboarding were deployed dormant. Their production release gates remain disabled.
- No existing employee, role, permission assignment, schedule, time record, payroll record, credential, document, or login was changed.
- No role received the new Recruiting or Onboarding permissions automatically.
- Candidate conversion cannot create a login, grant access, or activate an employee account.
- Production activation requires a separate, deliberate permission assignment and release-gate change.

### Database and Verification

- Added three forward-only production migrations for recruiting, controlled candidate conversion, and onboarding.
- Reconciled the production migration ledger with the deployed schema.
- Verified all 19 Stage 6 tables have row-level security enabled.
- Verified all six Stage 6 permissions exist with zero role assignments.
- Verified both Stage 6 release gates are disabled.
- Passed the dedicated Stage 6 safety validator.
- Passed the complete SygShift type, lint, test, and production-build suite: 113 test files and 565 tests.
- Passed the Cloudflare Worker deployment dry run with both Stage 6 feature flags disabled.

### Release Records

- Implementation commit: `b265c19`
- Cloudflare Worker version: `d33a4d9a-cfbf-4576-aaab-f5f2891feba7`
- Production health, readiness, SPA routing, and unauthenticated API-boundary probes passed after deployment.
- Architecture: `docs/architecture/HRIS_STAGE_6_RECRUITING_ONBOARDING.md`
- Operations runbook: `docs/operations/HRIS_STAGE_6_RECRUITING_ONBOARDING_RUNBOOK.md`
- Future roadmap: Stage 6 marked complete; Stage 7 remains the next HRIS stage.
