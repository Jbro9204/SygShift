# Employee File Editing, Protected Pay Rates, and Urgent Actions

Date: 09/01/2026
Status: Released to production

## Outcome

The authoritative Employee File can now maintain the core information HR reported as locked or missing. The Home page's Clock Out and Report Sick / Call-Off controls also use one consistent rounded, raised red treatment in both employee and operations layouts.

## Employee File

- Added permission-controlled editors for legal first, middle, and last name and employee number.
- Added an employment-profile editor for job title, Hourly or Salary timekeeping treatment, and a separate Full Time, Part Time, or Flex work classification.
- Added one restricted contact editor for personal and company email, mobile phone, home address, emergency-contact name, relationship, phone, and email.
- Kept start/hire and separation/termination dates in the established audited employment-date editor.
- Required MFA, exact `hr.people.manage`, a written reason, server validation, and an audit record for every core employee-file change.
- Required the additional `hr.people.restricted` permission for contact, address, and emergency-contact reads and writes.
- Kept primary role, login access, and permission maintenance in User Accounts and Roles & Permissions; lifecycle modules remain authoritative for onboarding, leave, and offboarding.

## Protected pay rates

- Added a compensation card inside the Employee File only for users with exact compensation permission.
- Kept pay amounts outside the general Employee File RPC and ordinary HR/Operations responses.
- Required a verified operations session and MFA completed within 15 minutes for every compensation read, proposal, and approval.
- Added effective-dated base-pay history with Hourly, Weekly, Biweekly, Semimonthly, Monthly, and Annual frequencies.
- Enforced maker-checker approval: the administrator proposing a rate cannot approve the same proposal.
- Limited the interface to five pending proposals and ten history entries at a time.
- Granted the existing system Admin role its cataloged compensation permissions; Human Resources and Operations Manager access remained unchanged and cannot see pay values.
- Created no pay amount, compensation proposal, employee classification, emergency contact, or other inferred employee value during deployment.

## Urgent action visuals

- Replaced the flat Clock Out treatment with a rounded red gradient, darker lower edge, shadow, hover lift, and pressed state.
- Applied the same shared urgent treatment to both Report Sick / Call-Off entry points.
- Preserved readable white icons and copy in light and dark modes, along with disabled and keyboard-focus behavior.

## Data and release safety

- Added forward-only migration `20260902010000_employee_file_editing_and_pay_rates.sql`.
- The first production attempt stopped and rolled back before commit because a preservation assertion referenced an obsolete payroll table name. The corrected migration used `private.payroll_export_batches` and then applied successfully.
- Preservation assertions verified existing employees, contacts, accounts, roles, individual permission overrides, schedules, time events, payroll export batches, compensation records, proposals, events, and non-Admin permission assignments were unchanged.
- The post-apply migration check reports the production database up to date.

## Verification

- Type checking passed.
- Lint passed with zero warnings.
- 138 test files and 676 tests passed.
- Worker and client production builds passed.
- Comprehensive Employee File, Stage 7 compensation, and Admin permission validators passed.
- All 44 desktop/mobile rendered browser tests passed, including the dedicated Employee File editor, emergency-contact modal, compensation card, urgent-button, accessibility, and horizontal-overflow checks.
- Deployed Cloudflare Worker version `ca7d270d-cea9-449d-bef2-0e86bb1679f1`.
- Primary and Worker fallback health/readiness endpoints returned `200`; the production login rendered successfully and an unauthenticated compensation request correctly returned `401`.
