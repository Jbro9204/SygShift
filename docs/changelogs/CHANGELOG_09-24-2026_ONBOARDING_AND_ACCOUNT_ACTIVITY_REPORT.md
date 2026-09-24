# Onboarding and User Account Activity Report

Date: 09/24/2026
Status: Released to production

## Outcome

The HR onboarding workflow is operational again and now supports both a new
pre-hire and an employee whose record was created through another authorized
channel. HR also has a protected **User Account & Sign-In Activity** report for
identifying completed logins, employees who have never completed a login, MFA
readiness, account state, roles, trusted devices, active sessions, and security
exceptions from one workspace.

## Onboarding workflow

- Replaced the fragile one-screen pre-hire form with a four-step guided flow:
  employee, employment, account readiness, and review.
- Added a clear choice between creating a new pre-hire and starting onboarding
  for an existing active employee who does not already have an onboarding case.
- Existing employees are searchable and retain their canonical employee ID,
  username, role, email, and account record instead of creating a duplicate.
- New pre-hires continue through the protected server workflow, which creates
  the employee, profile, onboarding case, and case tasks as one transaction.
- Case detail now includes account-readiness information so HR can see whether
  the username is reserved, login instructions were sent, the first login is
  complete, and MFA is enrolled.
- Errors remain inside the open wizard beside the step that needs attention;
  the modal no longer hides the reason the workflow could not advance.
- The layout uses consistent rounded controls, spacing, typography, button
  placement, contained scrolling, and responsive phone/small-laptop behavior.

## User Account & Sign-In Activity report

- Added a searchable report under **Reports** with filters for employment
  status, login state, account state, MFA state, and active role.
- Includes clear totals for employees in the current result, completed login,
  never completed login, disabled accounts, and MFA enrollment.
- Each employee record shows employee number, primary and additional roles,
  username, account status, most recent completed login, MFA methods, trusted
  devices, active sessions, and unresolved security exceptions.
- Added paginated results plus Excel and PDF exports generated from the same
  protected report contract.
- Export activity is audited independently from ordinary report viewing.

## Security and data controls

- Added separate `reports.account_activity.view` and
  `reports.account_activity.export` permissions.
- Baseline access is limited to Admin and Human Resources Manager. Other users
  receive no access unless an authorized administrator explicitly grants the
  exact permission.
- Navigation, application routes, Worker endpoints, service functions, and
  database execution privileges all enforce the boundary; this is not a
  sidebar-only restriction.
- The report and onboarding endpoints require the existing recent-HR-MFA
  session boundary.
- Completed-login status is sourced from the canonical protected sign-in
  completion record rather than inferred from a profile timestamp.
- Database service functions remain service-role-only, preserve RLS, and write
  audit events without exposing protected tables to the browser.
- The existing recruiting/onboarding validator was updated to validate the
  approved enabled state, unified recent-HR-MFA boundary, and shared pagination
  component instead of stale pre-release assumptions.

## Database release

- Applied only the two reviewed forward migrations:
  - `20260924154218_onboarding_account_readiness_report.sql`
  - `20260924160323_onboarding_personal_email_ambiguity_repair.sql`
- The second migration is a narrow forward repair for the legacy onboarding
  function's `personal_email` variable/column ambiguity.
- A production transaction exercised real pre-hire creation, employee profile
  creation, onboarding case/task creation, account-readiness output, and report
  output, then rolled the complete fixture back. No test employee, case, task,
  profile, role, or permission data remained.
- Production migration history confirms both release migrations are applied.

## Verification

- Full quality gate: 305 test files / 1,615 tests, strict TypeScript,
  zero-warning application/Worker lint, Worker build, client production build,
  and static-asset contract passed.
- Focused release guard: 3/3 onboarding, report, access-control, and migration
  contract checks passed.
- Responsive onboarding/report browser matrix: 4/4 checks passed at desktop and
  390-pixel phone widths, including horizontal-overflow prevention.
- The rendered onboarding and report workspaces were visually reviewed in both
  desktop and phone layouts.
- Stage 6 recruiting/onboarding production validator passed.
- Mandatory actual-component Time Clock preservation matrix: 42/42 desktop and
  mobile checks passed, including clock-in, early-clock acknowledgment, break,
  clock-out, same-shift return, ambiguous-shift selection, and duplicate-submit
  prevention.
- Both production origins returned healthy and ready. Onboarding and report
  routes returned HTTP 200, while the signed-out report API correctly returned
  HTTP 401.
- The custom domain and Worker origin serve byte-identical verified application,
  stylesheet, onboarding, and reports assets.

## Release references

- Source commit: `118f04cd1b9eef56a6ea4757f4ca557c132b78fa`
- Cloudflare Worker version: `7719f206-1c8b-40f0-8fed-de8363b309e3`
- Rollback tag: `rollback/pre-onboarding-account-activity-20260924`
- Verified application asset: `/assets/index-BR3vSjEF.js`
  (`AD6B43534D0B88ABDFF680C5440FC1A089B2C0E4E752F5FF58C1BA63E5D8D5DE`)
- Verified stylesheet: `/assets/index-CkhE3gY0.css`
  (`90953649C6D8EBC682B65D7654CC0C9551960F7971E45E78C7D004E2476A6090`)
- Verified onboarding asset: `/assets/HrisOnboardingPage-T9CpKb3T.js`
  (`CBD290CEBFA3838009F149C7654B0BA5CD6FCE323A1AE07A2C29C470FBB4E7CF`)
- Verified reports asset: `/assets/ReportsPage-CTwmWnmC.js`
  (`F11717E86D3CF5ED73B50DA3A3C6A407EDD571D39CD296F90090FB433745C243`)

