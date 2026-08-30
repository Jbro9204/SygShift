# SygShift Change Log — 08/30/2026

## HRIS Stage 7: Leave, Benefits, and Compensation Foundation

### Delivered

- Added independently protected Leave Administration, Benefits Administration, and Compensation workspaces.
- Preserved the existing employee time-off workflow as the operational source and linked protected leave cases to it without duplication.
- Added explicit downstream authorization records so approved leave cannot silently alter Schedule, Time & Attendance, or Payroll.
- Added separately protected medical and leave records connected to the private HR document vault.
- Added effective-dated benefit plans, plan versions, coverage tiers, eligibility rules, enrollment windows, enrollments, dependents, beneficiaries, and append-only history.
- Added effective-dated compensation grades, bands, components, employee records, proposals, approvals, and append-only history.
- Enforced recent MFA for compensation access and database-level separation between compensation proposers and approvers.
- Added exact permission checks, private row-level security, service-only database access, bounded 5/10/20 worklists, and staged disabled states.
- Added focused automated guards, architecture documentation, and an activation and rollback runbook.

### Production Safety

- Leave, Benefits, and Compensation are deployed dormant; all database and Worker release gates remain disabled.
- No policy, balance, entitlement, benefit promise, enrollment, grade, band, component, compensation record, proposal, or approval was created.
- No existing role or employee received a Stage 7 permission.
- Existing employees, accounts, roles, permission overrides, operational time-off requests, schedules, time records, payroll records, licensing records, documents, and audit history remain unchanged.
- Activation requires approved source information, deliberately assigned access, an isolated canary, recovery evidence, and a separate controlled release.

### Verification

- Passed the dedicated Stage 7 validator and focused security guard suite.
- Passed the complete SygShift type, lint, test, and production-build suite.
- Applied the additive Stage 7 migration with preservation assertions.
- Verified the production application, disabled release boundaries, and unauthenticated API protections after deployment.

### Release Records

- Production Cloudflare version: `47a38110-9c5f-4833-9420-d2ac77bc993a`.
- Architecture: `docs/architecture/HRIS_STAGE_7_LEAVE_BENEFITS_COMPENSATION.md`
- Operations runbook: `docs/operations/HRIS_STAGE_7_LEAVE_BENEFITS_COMPENSATION_RUNBOOK.md`
- Future roadmap: Stage 7 marked complete; Stage 8 is the next HRIS stage.
