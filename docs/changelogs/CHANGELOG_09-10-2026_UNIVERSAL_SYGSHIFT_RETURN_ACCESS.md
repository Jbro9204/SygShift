# Universal SygShift Return Access

Date: 09/10/2026

## Outcome

The reciprocal employee handoff is now complete for the current ten-role SygShift policy. An authorized employee can launch Sygilant from SygShift and return through Sygilant's SygShift control without another login. Guard employees remain eligible at AAL1 only while their canonical active account has no effective MFA requirement. Every other approved role still requires high assurance.

## Root cause corrected

- `apps.sygshift.access` existed as a critical, locked, MFA-protected permission, but only `system_admin` held an enabled role grant.
- The Guard AAL1 projection recognized `apps.sygilant.access` but not the reciprocal `apps.sygshift.access` permission.
- The outbound handoff therefore succeeded while the same Guard could not see or use the return control in Sygilant.

## Database release

- Added and recorded forward migration `20260912040000_universal_sygshift_return_access.sql`.
- Enabled `apps.sygshift.access` for exactly the ten approved active roles: Administrator, Chief, Dispatcher, Guard, Human Resources, Human Resources Employee, Operations Manager, Recruiting & Licensing, Scheduler, and Supervisor.
- Preserved the approved role MFA policy: Guard is false; all nine privileged roles are true.
- Extended `public.get_effective_permissions()` so the Guard-only AAL1 exception covers only the two reciprocal platform-launch permissions.
- Preserved direct employee denials because projection still begins with `private.employee_effective_permissions()`.
- Captured and compared complete fingerprints for employees, linked accounts, role assignments, employee overrides, access roles, permission catalog entries, and unrelated role permissions inside the migration transaction.
- Wrote nine append-only audit events for the newly enabled grants. The pre-existing Administrator grant was not rewritten as a new release event.
- Migration SHA-256: `FDC90B7B3A5B2D60A73678AA7A534531C0D40237959891F0ECE6EB246B61A37F`.

## Security verification

- Production preflight reproduced the one-way Guard defect and rejected unexpected catalog state, unapproved grants, missing protected functions, or a changed role/MFA matrix.
- Production postflight reported 10 approved role grants, 0 unapproved grants, 2 intact protected catalog entries, authenticated-only projection execution, and 33 active Guard accounts with both underlying launch permissions.
- The rollback-only session matrix proved that an eligible Guard receives both platform launchers at AAL1, while every unrelated MFA-sensitive permission remains absent.
- The same matrix proved that an MFA-required employee receives neither launcher at AAL1 and receives both after AAL2.
- The linked database linter reported the same nine pre-existing errors in unrelated legacy functions. It reported no issue for `public.get_effective_permissions()` or this migration.
- No employee, account, password, MFA method, FIDO credential, session, role assignment, employee override, or permission-catalog record was changed.

## Browser acceptance

- A synthetic Guard signed into SygShift without an MFA prompt and launched Sygilant without another login.
- Sygilant restored the same canonical Guard role and showed only the employee navigation appropriate to that role.
- After the production permission refresh, Sygilant displayed the SygShift return control.
- The return control opened the authenticated SygShift Basic Home without another login or MFA prompt.
- Direct navigation to Sygilant Dispatch and Access Control returned the Guard to the authorized dashboard without rendering either protected workspace.
- No assertion, ticket, token, or shared-session secret appeared in either platform URL.

## Regression verification

- `pnpm check`: passed with TypeScript, zero-warning application lint, 229 test files, 1,178 tests, Worker build, and client production build.
- Focused reciprocal source guard: 5/5 tests passed.
- Mandatory launcher and actual-component Time Clock matrix: 54/54 desktop/mobile checks passed.
- Required fresh production build after browser testing: passed.
- `git diff --check`: passed.

## Release boundary

This release changes the shared database permission projection and repository migration/test records only. No SygShift or Sygilant application bundle changed, so no additional Cloudflare deployment was required. Both live applications consumed the corrected projection immediately after refresh.

## Rollback

- Pre-release source tag: `rollback/pre-universal-sygshift-return-access-20260910` at `3e8ffe7`.
- Database history remains forward-only. Any corrective database rollback must be a reviewed forward migration that preserves audit and shared-identity history.
- The shared-identity feature controls remain the operational containment path if reciprocal launch must be disabled while a forward correction is prepared.
