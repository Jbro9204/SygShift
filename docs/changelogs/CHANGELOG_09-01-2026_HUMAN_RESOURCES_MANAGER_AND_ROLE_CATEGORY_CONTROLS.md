# SygShift Change Log — Human Resources Manager and Role Category Controls

**Date:** 09/01/2026  
**Area:** Roles & Permissions / HR & Finance  
**Status:** Production database and application release verified

## Outcome

The existing protected Human Resources role is now **Human Resources Manager**. It is an MFA-required, additive leadership role at the same organizational tier as Operations Manager, with complete current HR authority and the supporting employee-lifecycle access needed to operate that work from end to end.

The role editor also now provides **Select all** and **Clear all** inside every permission category in both Create Role and existing-role editing. Category controls always apply to the complete category, even while the visible list is filtered by search.

## Human Resources Manager access

- Enabled every active permission in the **HR & Finance** catalog, including HR People, recruiting, onboarding, all protected document vaults, leave, benefits, compensation, total rewards, talent, learning, cases, safety, assets, offboarding, self-service, HR automation, HR reporting, and payroll integration controls.
- Added the supporting employee-account, directory, licensing, training, communications, reporting, request, schedule-visibility, team-time, payroll-preparation, payroll-export, and time-exception permissions required for complete HR operations.
- Retained Admin-only boundaries for roles and permissions, security administration, maintenance/backend controls, destructive employee deletion, account-security/MFA administration, sites/posts, patrol, and schedule editing or publishing.
- Preserved the existing role code and database identifier so current and future assignments continue to reference one canonical role.
- Preserved the existing one-employee assignment; no person was assigned, removed, or reclassified by this release.
- Kept existing HR feature flags unchanged. A dormant HR module remains dormant until its separately controlled release, but Human Resources Manager already has its intended permission when that module is activated.

## Create Role usability

- Opened the first permission category by default when Create Role opens.
- Added a clear category-control strip with the selected count and total permission count.
- Added category-level **Select all** and **Clear all** actions to Create Role and the existing-role permission workspace.
- Kept selections in unrelated permission categories untouched.
- Kept sensitive-permission confirmation and unsaved-change protection in place.
- Added responsive light/dark styling so the category controls remain readable, touchable, and contained on desktop and mobile.

## Data and access safety

- Forward migration `20260902050000_human_resources_manager_complete_authority.sql` upgraded the existing role in place.
- The migration fingerprinted employee role assignments, employee permission overrides, every other role, every other role-permission bundle, and the permission catalog, and aborted if any protected state changed.
- Production verification found 110 intended permissions, 110 enabled permissions, zero missing permissions, and zero extra permissions.
- No employee record, primary role, account, schedule, punch, payroll row, license, document, or audit-history row was changed.

## Verification

- Type checking passed.
- Linting passed with zero warnings.
- All 143 test files and 695 tests passed.
- Access-control inventory and HR Admin baseline validation passed.
- Worker and client production builds passed.
- Responsive desktop and mobile category-control checks passed.
- Production migration marker `20260902050000` is reconciled in the hosted migration ledger.
- Deployed Cloudflare Worker version `ffbd5c87-b5e0-4f40-9758-c5a8710a25fc`.
- Primary and fallback login, health, and readiness checks returned HTTP `200`; readiness reported `ready: true`.
- The live Roles & Permissions asset contains the new category controls and production styling.

## Recovery position

The release is forward-only. If the role boundary must be revised, use a new migration that changes only the `human_resources` permission bundle while preserving its role identifier and employee assignments. The previously deployed application version remains available through Cloudflare version rollback if the editor presentation needs to be reverted.
