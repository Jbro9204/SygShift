# Unified Workforce Role Transitions

Date: 09/30/2026  
Status: Released to production

## Outcome

Employee access management now uses one understandable contract:

- Every employee has exactly one **primary workforce role**. That role is the
  employee's scheduling and timekeeping identity.
- Additional roles add access without silently changing that workforce
  identity.
- Individual grants and explicit denials remain intentional per-person
  exceptions and are shown separately from role-derived access.
- User Accounts and Employee Permissions use the same consolidated role list,
  labels, and primary-role action instead of presenting overlapping role
  systems.

Promoting or demoting an employee is an explicit, audited transition. The
operation removes obsolete canonical primary-role membership, assigns the new
primary role, and retains unrelated custom roles and reviewed individual
permission exceptions. No current employee was reclassified merely because
the role model was repaired.

## Root cause

SygShift stored the primary workforce role on the employee record while also
using access-role memberships and direct permission overrides. The two role
surfaces did not communicate those purposes consistently. A role change could
therefore look duplicated, preserve the former primary role as unexplained
additional access, or apply a cached desired state that was no longer the
authoritative permission state.

The same ambiguity reached employee-creation and conversion paths. Elevated
roles could be selected before the final database write without every path
revalidating the acting user's current role-management authority and Admin
status at that boundary.

## Application changes

- Consolidated the workforce and additional-access choices into one role
  library with an explicit **Make primary** action.
- Added clear **Primary** and **Additional** summaries to User Accounts.
- Kept view-only access searchable but genuinely read-only, including role
  creation, permission, and home-selection controls.
- Made self role/access changes read-only and kept separated employees visible
  for audit without permitting access mutation.
- Prevented a former primary workforce role from being immediately re-added as
  additional access in the same unsaved transition.
- Preserved direct grants and displayed direct denials independently instead
  of treating effective access as a new desired-state override.
- Required an audit reason for an existing employee's role transition without
  incorrectly requiring one during initial employee creation.
- Refreshed both Access Center and User Directory data after successful saves.
- Kept User Directory visibility independent from permission-administration
  authority.
- Prevented onboarding and import screens from silently replacing an
  unauthorized elevated role with Guard; the user now receives an explicit
  authorization message and must make a deliberate permitted choice.
- Isolated each employee editor's draft, validation error, confirmation modal,
  and mutation state so switching employees cannot carry one person's pending
  role change into another person's record. The employee search and scroll
  position remain stable while that editor state resets.
- Centralized canonical workforce-role labels across User Accounts,
  onboarding, HR employee files, training, notifications, SygSphere,
  licensing, reports, and the application shell. The exact labels now include
  **Recruiting & Licensing** and **Human Resources Employee**.
- Distinguished protected roles from ordinary custom roles in the Role
  Library. Human Resources Employee, Human Resources Manager, and Operations
  Manager now appear as **Protected access role**.
- Replaced the User Account & Sign-In Activity report's stale hard-coded role
  list with the active role catalog. The report now includes Chief, custom,
  protected, and future active roles, and a system-role filter finds both
  primary and additional memberships.

## Database and Worker safety

- Added an atomic primary-role transition RPC and a separate role-only RPC so
  role changes do not overwrite newer direct permission decisions.
- Serialized role and direct-override writers on the employee row to prevent a
  stale role save from erasing a concurrent grant or denial.
- Retained legacy RPC compatibility while routing those calls through the same
  guarded transition behavior.
- Enforced primary Admin authority for assigning Admin, including when Admin
  also exists as an additive role.
- Protected self access, separated employees, the last active recovery Admin,
  and critical Admin permissions at the database boundary.
- Counted only active, enabled, activated Admin accounts for recovery-Admin
  protection; an unactivated invitation cannot satisfy that safeguard.
- Revalidated candidate approval, onboarding, and operational import authority
  at the final write and prevented partial employee, contact, person, worker,
  or role records when authorization fails.
- Preserved the controlled separated-employee removal workflow while blocking
  role or override changes to separated records.

## Data preservation

- No production employee's primary role or additional access was guessed,
  normalized, or automatically reassigned.
- Deliberate additional roles, including reviewed additional Admin access,
  remain intact until an authorized person explicitly changes them.
- Unrelated custom roles, direct grants, direct denials, audit history, and
  employee status are preserved across promotion and demotion.
- Retired duplicate role definitions remain historical records rather than
  being destructively deleted.

## Key files and migrations

Database migrations:

- `supabase/migrations/20260930160000_atomic_primary_role_access_profiles.sql`
- `supabase/migrations/20260930173000_access_profile_security_invoker_boundary.sql`

Key application and Worker files:

- `src/components/EmployeeRolesField.tsx`
- `src/lib/employeeRoleSelection.ts`
- `src/lib/workforceRoleAssignment.ts`
- `src/pages/AccessControlPage.tsx`
- `src/pages/UserAdminPage.tsx`
- `src/reports/UserAccountActivityReportWorkspace.tsx`
- `src/data/userAccountActivityReport.ts`
- `worker/index.ts`

Regression coverage was added or expanded in the related component, data,
Worker, uniform-label, browser, and SQL test files.

## Verification completed

- Full repository gate: `pnpm check` passed with strict TypeScript,
  zero-warning lint, **349 files / 1,860 tests**, production builds, and the
  static-asset contract.
- The responsive User Accounts and Employee Lifecycle browser suite passed
  **8/8** across desktop and mobile, light and dark modes.
- The mandatory Time Clock browser suite passed **42/42** across desktop and
  mobile.
- The combined migration and SQL regression rehearsal used exactly one outer
  transaction and one final rollback; it passed without retaining production
  changes.
- Installed-boundary SQL regressions passed for both the atomic role-profile
  contract and the SECURITY INVOKER wrapper boundary. The database advisor
  produced no new warning delta after installation.
- Regression coverage includes promotion and demotion, custom-role and direct
  override preservation, concurrent writer ordering, self and separated
  employee denials, last-recovery-Admin protection, elevated onboarding and
  candidate conversion, denied final-write paths with no partial records,
  employee-switch state isolation, exact role labels, and account-report
  filtering for both primary and additional system-role memberships.
- No real employee assignment was modified during validation.

## Final release evidence

- Production migration ledger:
  - `20260930201818 atomic_primary_role_access_profiles`
  - `20260930203517 access_profile_security_invoker_boundary`
- Pushed source lineage: `8dedd681`, `9ec5b6e`, `48a0400`, and final
  application commit `b9d0972` on `origin/main`.
- Cloudflare Worker version:
  `d69793e0-dede-413b-a4ed-90c097a19f57`.
- `https://app.sygilant.us` and
  `https://sygshift.sygilant.workers.dev` both returned healthy and ready with
  every required readiness binding true.
- Both production origins served the same deployed asset set, including
  `/assets/index-DvI59vQu.js` and `/assets/index-BTEZ2SBJ.css`.
- Authenticated live Role Library verification showed all six workforce roles,
  Chief, Human Resources Employee, Human Resources Manager, and Operations
  Manager with the correct system/custom/protected classification.
- Authenticated live Employee Permissions verification showed Zach Ward with
  **Recruiting & Licensing** as the primary workforce role,
  **Human Resources Employee** as one additional role, **113** inherited and
  effective permissions, **0** individual additions, and no false unsaved
  state. No save was submitted.
- Authenticated live User Account & Sign-In Activity verification showed the
  dynamic role catalog and filtered **Human Resources Employee** to the
  expected one matching employee, proving additional membership is included.
  No export or account mutation was performed.

Rollback tag prepared before the repair:
`rollback/pre-unified-workforce-role-repair-20260930`.

## Remaining hierarchy decision

This repair clarifies and secures how roles are assigned; it does not invent
the company's pending organizational hierarchy. Michelle and Jordan still
need to approve the Human Resources versus Human Resources Manager boundary
and the intended Operations Manager scope before those role definitions are
changed.
