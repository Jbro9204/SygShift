# SygShift Change Log — HRIS Stage 10 Payroll Integration Hardening

**Date:** 08/30/2026

**Area:** HR & Finance / Payroll Integration

**Release state:** Dormant control plane; external integration and cutover disabled

## Completed

- Added a protected Payroll Integration workspace for authorized administrators.
- Added six exact payroll-integration permissions without assigning them to any current role or employee.
- Added a versioned HR-to-Payroll contract that keeps SygShift Payroll authoritative.
- Added payroll-impacting change proposals with documented reasons, recent-MFA enforcement, and independent maker-checker approval.
- Added reconciliation runs and immutable difference records anchored to locked payroll export batches and rows.
- Added versioned integration events, disabled HTTPS-only webhook definitions, delivery-attempt evidence, rollback plans, rollback executions, and enterprise verification runs.
- Added separate integration, webhook, and enterprise-cutover release gates. All three default to off in both the database and Worker configuration.
- Added private row-level security, append-only evidence, trigger-maintained SHA-256 digests, bounded 5/10/20 worklists, and service-only data access.
- Added preservation assertions covering employees, roles, role permissions, individual overrides, accounts, schedules, time events, payroll batches, and payroll rows.

## Production safeguards

- SygShift Payroll remains the sole payroll authority.
- No external payroll target was configured or contacted.
- No webhook was enabled.
- No payroll proposal, approval, reconciliation run, difference, event, subscription, rollback execution, or external handoff was created.
- No employee role, permission, account, schedule, time event, payroll batch, or payroll row was changed.
- A real external integration remains blocked until the target, contract approval, owners, recovery evidence, isolated canary, rollback test, and final reconciliation are authorized.

## Verification

- Applied migration `20260831200000_hris_stage10_payroll_integration_hardening.sql` to the linked production database.
- Passed TypeScript validation and zero-warning lint.
- Passed 118 automated test files and 597 tests.
- Passed Worker and client production builds.
- Verified the dormant Stage 10 contract and release-gate validator.
- Deployed Cloudflare Worker version `850b1311-73c3-4007-a512-c6688ac201b8`.
- Verified `https://app.sygilant.us/login` returns `200` and the unauthenticated Stage 10 API returns the expected `401` without exposing protected data.
