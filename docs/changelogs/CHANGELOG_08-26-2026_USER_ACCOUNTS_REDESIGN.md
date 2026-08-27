# User Accounts Redesign

Date: 08/26/2026

## Outcome

The User Accounts administration page has been reorganized into a compact account-management workspace that is easier to scan, filter, and operate on desktop, tablet, and mobile. This release changes presentation and workflow organization only. It does not change employee records, account credentials, authentication rules, role assignments, authorization, onboarding eligibility, removal safeguards, or audit behavior.

## Accounts workspace

- Replaced the oversized page sections with a compact header, four account-summary metrics, a focused filter bar, and a separate bulk-action row.
- Added clear filters for employee search, role, employment status, login status, and account activity.
- Preserved the existing Add employee, Create missing logins, and Send new user invites actions with their existing permission checks and eligibility rules.
- Reorganized the account table into Employee, Role & Employment, Login, Last Activity, and Manage columns.
- Kept legal employee names and permanent usernames in the administrative account workspace.
- Added responsive account cards on narrow screens so labels remain readable without horizontal overflow.

## Employee account workspace

- Rebuilt the Manage employee dialog into three focused tabs: **Profile**, **Login & Security**, and **Onboarding**.
- Added a stable employee summary showing employee name, ID, username, role, and account status.
- Preserved every existing employee field and account action inside the appropriate tab.
- Kept credential and licensing work outside User Accounts and linked administrators to the Licensing Center boundary.
- Moved separation and deletion controls into an administrator-only collapsed area so normal account work remains uncluttered.
- Kept password, account enable/disable, trusted-device revocation, MFA reset, welcome email, and login-instruction actions independent from profile saves.
- Added a sticky Profile save bar with explicit unsaved-change status, Cancel, and Save employee actions.
- Added confirmation before closing the account workspace or changing tabs with unsaved profile changes.
- Preserved immediate server-confirmed account refresh behavior after security and onboarding actions.

## Interface quality

- Standardized control heights, button alignment, spacing, typography, cards, tabs, status chips, and action groups with the existing SygShift design system.
- Increased the account dialog width on larger screens while preserving contained scrolling and readable side spacing.
- Added desktop, tablet, and mobile layouts without changing the underlying account operations.
- Preserved accessible labels, dialog structure, tab semantics, and focus-visible controls.

## Security and data safeguards

- No database migration was required.
- No employee, role, permission, credential, login, MFA factor, trusted-device record, or audit record was modified by the release.
- Existing database and Worker authorization boundaries remain authoritative.
- Existing Admin and MFA requirements remain unchanged.
- Existing temporary-password generation, invite delivery, account removal, and operational-history protections remain unchanged.

## Validation

- Type checking passed.
- Linting passed.
- All 85 automated test files passed: 427 tests.
- Production build passed.
- User Accounts layout and button regression coverage passed.
- Diff whitespace validation passed.
- The unsigned local browser correctly remained at the secure sign-in boundary; authenticated UI inspection was not bypassed with stored or shared credentials.

## Production

- Primary application: https://app.sygilant.us
- Worker fallback: https://sygshift.sygilant.workers.dev
- Production version: recorded after deployment.
