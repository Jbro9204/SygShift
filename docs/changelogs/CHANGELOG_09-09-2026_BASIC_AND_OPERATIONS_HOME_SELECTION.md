# 09/09/2026 — Basic Home and Operations Home Selection

## Outcome

- Added one explicit **Home experience** selector to the existing role editor and custom-role creator.
- **Basic Home** keeps the employee-focused landing page: personal schedule, time, requests,
  announcements, and assigned work.
- **Operations Home** enables the management landing page: company coverage, staffing totals,
  priority queues, and management workspaces.
- Basic Home is the safe default. A user receives Operations Home only when at least one effective role
  grants the new `home.operations.view` permission together with the existing `operations.view`
  permission.
- The Home route remains available to every authenticated employee, preventing a missing management
  permission from creating a blank or redirect-loop landing page.

## Role defaults released

- Operations Home: Admin, Supervisor, Chief, Human Resources Manager, and Operations Manager.
- Basic Home: Guard, Dispatcher, Scheduler, Recruiting & Licensing, and Human Resources Employee.
- Additive roles are honored. If any effective role grants Operations Home, the employee receives that
  experience without changing the employee's primary scheduling and timekeeping role.
- Admin's Operations Home selection remains protected because the canonical Admin role must retain all
  active permissions.

## Administration experience

- The selector appears under **Administration → Users & Roles → Roles & Permissions** after choosing a
  role, and inside **Create role** for new custom roles.
- The two options use concise descriptions and a single radio choice so administrators do not have to
  locate or combine multiple technical permissions.
- Selecting Operations Home automatically includes the required Operations workspace permission.
- Removing the Operations workspace permission automatically returns the role to Basic Home.
- The underlying Home permission is hidden from the ordinary permission accordions so the same setting
  is not duplicated elsewhere in the editor.

## Access-control and data safety

- Exact forward migration `20260909190000_role_home_experience_selection.sql` created the new active
  permission, assigned the approved role defaults, recorded five audit rows, and asserted that no
  employee, role, unrelated permission mapping, direct override, or operational record changed.
- Production verification found five Operations Home role mappings, zero invalid mappings missing
  `operations.view`, zero Admin permission gaps, and the expected effective outcome across every active
  employee.
- No schedules, shifts, punches, payroll records, HR records, employee accounts, MFA settings, or
  authentication behavior changed.
- Pre-release rollback tag: `rollback/home-experience-selector-pre-release-20260909`.

## Verification

- `pnpm check` passed 219 test files / 1,091 tests, TypeScript, zero-warning lint, Worker build, and
  client build.
- The Home-experience role editor passed its desktop and mobile browser checks in both light and dark
  themes.
- The required post-deployment Time Clock workflow passed 38/38 desktop and mobile checks.
- Production health returned `ok`, readiness returned `ready`, and the live application served the
  exact release bundle `/assets/index-DT-EwAMP.js` with matching SHA-256
  `08ce4a8a89456960335c49548650c0be7484e2281d1cf44da7c1fe92901a0563`.
- Authenticated production verification confirmed Jordan's Operations Home, the Admin selector's
  protected state, and Dispatcher's Basic Home selection without saving or changing either role.

## Release

- Feature source commit: `bc94ea8`
- Guidance correction commit: `0bdd0f4`
- Cloudflare Worker version: `b8828c1d-af96-41cc-bb9b-45ab828bc365`

