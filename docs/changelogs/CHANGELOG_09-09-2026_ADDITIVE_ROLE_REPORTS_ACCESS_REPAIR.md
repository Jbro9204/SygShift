# Additive Role Reports Access Repair

**Release date:** September 9, 2026  
**Status:** Released to production  
**Implementation commit:** `f073f30`  
**Database regression commit:** `81ded88`  
**Migration:** `20260910090000_effective_role_operations_report_access.sql`  
**Rollback tag:** `rollback/reports-effective-role-pre-fix-20260909`

## Reported issue

Zach had three visible roles—Recruiting & Licensing as the workforce role plus assigned Admin and Human Resources access—but could not open the Reports workspace.

## Production diagnosis

The role assignments were correct. Production confirmed:

- employee and login are active;
- Admin and Human Resources access roles are assigned;
- MFA is enrolled and the current session is AAL2;
- no direct permission denial exists;
- the canonical session resolves 190 effective permissions;
- `reports.view`, `reports.export`, `time.reports.view`, `licensing.view`, `patrol.reports.view`, and Client reporting permissions are effective.

The failure occurred after route authorization. The Reports landing page requested `get_operations_report()`, whose database boundary still used `is_supervisor_or_admin()`. That legacy helper considered only the single workforce role and ignored additive Admin/HR access. Because Zach's workforce role is Recruiting & Licensing, the summary request failed and the Reports page displayed an unavailable state even though his effective permissions were valid.

## Correction

Migration `20260910090000_effective_role_operations_report_access.sql` replaces only that legacy authorization condition with:

```sql
public.has_effective_permission('reports.view')
```

The migration reads and safely rewrites the installed function definition, refuses to proceed if the expected old boundary is absent, retains the existing report aggregation body, and preserves the authenticated execution grant. This honors all active assigned roles and direct permission overrides while continuing to apply permission-catalog activity, explicit denies, employee status, and MFA.

No role assignment, employee record, MFA factor, trusted device, schedule, punch, payroll record, report data, or audit history was changed.

## Production verification

- The migration applied successfully and version `20260910090000` was recorded in production history.
- A production request evaluated with Zach's actual employee/account context at AAL2 returned the complete operations-report object with People, Schedule, and Requests sections.
- The rollback-only database matrix confirmed an active employee without `reports.view` remains denied.
- The same authorized additive-role subject at AAL1 remains denied, confirming verified MFA is still required.
- Authenticated execution permission on `get_operations_report()` remains present.

## Release verification

- Full repository gate: **220 test files / 1,101 tests passed**.
- TypeScript passed.
- ESLint passed with zero warnings.
- Production Worker and client builds passed.
- Mandatory Time Clock workflow: **38 desktop/mobile checks passed**.
- Production `/api/v1/health`: HTTP 200, `ok`.
- Production `/api/v1/ready`: HTTP 200, `ready`.

No Cloudflare application deployment was required because the defective authorization boundary and its correction are database-resident. The live application bundle already contains the additive Reports route and presentation support released earlier on September 9.

## Recovery

Application source can be referenced from tag `rollback/reports-effective-role-pre-fix-20260909`. The migration is an authorization correction and should not be reverted by changing employee roles. Any database rollback would require a reviewed forward migration restoring the earlier function definition; reverting would intentionally reintroduce the additive-role access defect.
