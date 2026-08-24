# SygShift Role and Permission QA

Date: 08/24/2026

## Outcome

The live SygShift access model is permission-enforced and the Guard role now follows a strict least-privilege baseline. No employee's assigned role, employment status, account state, additional role assignment, or person-specific override was changed during this QA.

## Production assignment verification

| System role | Active employees | Granted permissions |
| --- | ---: | ---: |
| Admin | 2 | 65 |
| Dispatcher | 3 | 23 |
| Guard | 35 | 11 |
| Recruiting & Licensing | 1 | 18 |
| Scheduler | 1 | 43 |
| Supervisor | 5 | 47 |

- Active employees: 47
- Active employees without an account: 0
- Active employees with a disabled account: 0
- Additional access-role assignments: 0
- Active person-specific overrides: 0

## Approved Guard access

Guards receive only these self-service permissions:

1. `actions.self.view` — View their own action center.
2. `announcements.view` — View active announcements intended for them.
3. `availability.view` — View their own availability.
4. `events.view` — View eligible events and openings.
5. `operations.view` — Open the employee Home workspace.
6. `requests.view` — View their own time-off and coverage requests.
7. `schedule.self.view` — View their own published schedule.
8. `shift_pool.view` — View eligible open shifts and coverage requests.
9. `time.punch` — Clock in, clock out, and use approved time-clock actions.
10. `time.self.view` — View their own time records and correction status.
11. `training.view` — View assigned training.

Guards do not receive team schedule access, team time access, employee directory access, credential access, site/post administration, patrol administration, announcement composition, report access, payroll access, user administration, role administration, or accountability-event management.

## Role boundary summary

- **Dispatcher:** Company schedule, operations, patrol, reporting, notifications, directory, and accountability visibility appropriate to Dispatch; no schedule publishing, payroll export, role administration, user administration, or credential editing.
- **Scheduler:** Company scheduling, schedule publication, sites/posts, availability, requests, shift pool, announcements, directory updates, credential editing, and team time management; no payroll export, licensing configuration, security administration, or role administration.
- **Supervisor:** Scheduler-level operational control plus payroll review/export, manual time maintenance, reports, and notification/banner management; no user administration, role administration, licensing configuration, or security administration.
- **Recruiting & Licensing:** Own schedule/time plus directory, credential, licensing, and basic login-management responsibilities; no team schedule, scheduler, patrol, site/post, team-time, payroll, announcement-composition, or role-administration access.
- **Admin:** Complete administrative and operational access across the current 65-permission catalog.

## Enforcement verified

- Direct application routes and sidebar navigation use the central permission policy.
- Page actions are hidden unless the session has the corresponding effective permission.
- MFA-sensitive permissions are absent from the effective session until the session reaches MFA assurance level 2.
- Database functions independently require effective permissions and MFA where applicable.
- Row-level policies limit Guard schedule data to the Guard's own active assignments on published schedules.
- Employee and availability rows are self-only unless a workforce-management permission is present.
- Announcements are audience-filtered.
- Sites and posts remain hidden without site permissions.
- Licensing Center access remains unavailable to Guards.

## Production impersonation results

- A live Guard account returned only its own employee row, published schedules, shifts, and assignments; no other employee assignment was visible.
- The Guard could not read sites, posts, another employee's availability, or Licensing Center data.
- Scheduler and Supervisor accounts could open the Licensing Center at MFA assurance level 2 through their existing `directory.edit_credentials` permission.
- Scheduler and Supervisor credential access did not grant licensing configuration, employee-profile management, or licensing communication actions.

## Automated verification

- Guard route allow-list and deny-list tests.
- Guard database-policy regression tests.
- Credential-editor route test.
- Full type checking and lint.
- 68 test files / 347 tests passed.
- Production application build passed.
- Access-control inventory passed with no role-name navigation fallback and no legacy role-based row policy.
- Deployed Cloudflare Worker version `5d17d26a-e401-460b-8847-914bfa77281f`.
- Live custom-domain health, readiness, login-route, and static-asset checks passed.

## Change control

Any future Guard permission addition must be deliberate and accompanied by an update to the exact Guard permission assertion in migration `20260824183000_guard_least_privilege_and_self_service.sql`. A deployment will fail rather than silently accepting a broader Guard baseline.
