# SygShift Access-Control Inventory

Date: 08/21/2026

Scope: current application source, Cloudflare Worker, live Supabase project, active employee access, MFA boundaries, database functions, RLS policies, and grants

Phase: baseline inventory only; no authorization behavior was changed

## Executive summary

SygShift has a functioning permission catalog and effective-permission engine, but that engine is not yet the sole authority everywhere. Newer workflows use effective permissions, while several older client, Worker, function, and RLS paths still fall back to a fixed role name. That creates two failure modes:

1. Removing a permission in Roles & Permissions may not remove every related screen or action when a legacy role fallback still grants it.
2. Giving a permission to a custom role or individual may not unlock every related screen or action when the code still requires a specific legacy role.

The live baseline is favorable for a controlled conversion: all 47 active employees currently receive access only from one of the six system roles. There are no active extra-role assignments and no active person-specific permission overrides. That gives us a clean before-state and reduces rollout ambiguity.

No production access rules were changed during this inventory. The current role matrix must be reviewed and approved before enforcement is modified.

## Authoritative baseline

| Item | Live value |
| --- | ---: |
| Active employees captured | 47 |
| Active roles | 6 |
| Active permission definitions | 64 |
| Active extra-role assignments | 0 |
| Active person overrides | 0 |
| Live database function signatures | 302 |
| Live RLS policies | 50 |
| Public and storage tables inspected | 60 |
| Live migrations | 78 |
| Latest live migration | `20260821142000` |
| Snapshot fingerprint | `f442698308b2a5ef5b2e6ea75a505e41d63987ec63eb98acfbe928910d906628` |

The complete employee-level before-state is stored locally at:

`outputs/access-control/production-access-baseline-08-21-2026.json`

That file is intentionally excluded from Git because it contains employee identifiers and effective-access details. The fingerprint above can be used to prove which snapshot was used. The safe current system-role matrix is versioned at [ACCESS_CONTROL_CURRENT_ROLE_MATRIX_08-21-2026.csv](./ACCESS_CONTROL_CURRENT_ROLE_MATRIX_08-21-2026.csv).

## Current production role baseline

| System role | Active employees | Permissions | Current source of effective access |
| --- | ---: | ---: | --- |
| Admin | 2 | 64 | Primary role |
| Dispatcher | 3 | 22 | Primary role |
| Guard | 35 | 13 | Primary role |
| Recruiting & Licensing | 1 | 18 | Primary role |
| Scheduler | 1 | 42 | Primary role |
| Supervisor | 5 | 46 | Primary role |

The matrix records the current system, not an approved future design. Before enforcement changes, business owners must explicitly confirm high-impact assignments such as:

- Guard: `time.view`
- Dispatcher: `accountability.manage`
- Scheduler: `admin.users.basic` and `admin.users.invite`
- Recruiting & Licensing: `admin.users.basic` and `admin.users.manage`

These are review points, not findings that the assignments are wrong.

## Permission catalog

| Risk level | Count |
| --- | ---: |
| Critical | 24 |
| Sensitive | 21 |
| Standard | 19 |

Fifty-six permissions require MFA according to the live catalog; eight do not. The catalog is already detailed enough to become the authority, provided all enforcement layers consult it consistently.

## Application surface inventory

| Surface | Count | Result |
| --- | ---: | --- |
| Router paths | 28 | Inventoried |
| Sidebar navigation items | 17 | Inventoried |
| Navigation items with role fallback | 13 | Must be converted |
| Interactive source controls | 393 | Mapped for phase-by-phase review |
| Distinct client RPC names | 136 | All 136 exist in the live database |
| Worker endpoint patterns | 15 | Inventoried |
| Production source role references | 38 | Classified as bypass or review candidate |

### Route boundary

`AppShell.canOpenNavigationItem` first accepts any listed permission and then accepts a listed legacy role. The same helper controls sidebar visibility and exact top-level route entry. Thirteen of seventeen navigation items still provide that role fallback.

The nine `/time/*` deep links do not have exact navigation records, so the AppShell route check does not run for those paths. Most of the implemented Time pages perform their own permission checks and the RPC layer checks again, but this is fragmented rather than a single declarative route policy. `/time/timecards` and `/time/rules` are placeholder routes and must still receive explicit route-policy definitions before the enforcement phase is considered complete.

`/login` is an unauthenticated entry point and `/account-security` is an authenticated self-service security route; neither should require an ordinary business permission.

### Confirmed client bypasses

- `src/components/AppShell.tsx`: navigation and exact top-level routes accept a matching role even when no matching effective permission exists.
- `src/time/timePermissions.ts`: Admin automatically passes every Time permission helper.
- `src/pages/ActionCenterPage.tsx`: Admin automatically receives management and reporting actions.
- `src/pages/PeoplePage.tsx`: Admin automatically passes permission checks; availability editing also accepts four hard-coded roles.
- `src/pages/SchedulePage.tsx`: Admin and four operations roles receive schedule capabilities independently of the permission matrix.
- `src/pages/SitesPage.tsx`: Admin automatically receives site-management UI.
- `src/pages/UserAdminPage.tsx`: Admin automatically passes general user permissions; some actions require the Admin role even if a custom role has the required permission.

### Role references that require classification, not automatic removal

- Displaying a human-readable role name.
- Selecting the employee-versus-operations presentation mode.
- Showing guard-specific request language.
- Protecting account-security enrollment for identities whose access requires MFA.
- Counting Admin records for safety rules.

These references may remain role-aware if they do not grant data or action authority. They must not be used as authorization shortcuts.

## Cloudflare Worker inventory

The Worker exposes health/readiness, account recovery, user administration, notification processing, and attendance-report endpoints.

Confirmed gaps:

- `requireAdminMfa` accepts the Admin role as a fallback for `admin.users.manage`.
- notification processing accepts one of four hard-coded operations roles or a notification/announcement permission.

Positive controls:

- user-invite email paths require the dedicated `admin.users.invite` permission.
- MFA recovery-code retrieval requires an authenticated account, an enrolled factor, and AAL2.
- the attendance-report endpoint authenticates the employee and delegates the business rule to `report_attendance_accountability_event`.
- service-role operations remain inside the Worker and are not exposed to the browser.

## Live database inventory

### Functions

| Function classification | Count |
| --- | ---: |
| Uses an effective-permission helper | 77 |
| Contains a role reference | 68 |
| Contains role reference and effective permission | 39 |
| Contains role reference without effective permission | 29 |
| Contains an MFA-related reference | 74 |

Role-only functions are candidates, not automatically vulnerabilities. Some are foundational helpers such as `current_app_role`, `is_admin`, and `get_session_context`. Others directly support administrative, licensing, schedule, or time-maintenance operations and must be converted or formally justified.

Priority function candidates include:

- `private.require_admin_mfa`
- `private.require_licensing_mfa`
- `public.admin_create_employee`
- `public.admin_update_employee`
- `public.admin_separate_employee`
- `public.admin_upsert_employee_credential`
- `public.get_licensing_center`
- `public.cancel_schedule_draft`
- `public.resolve_schedule_review_shift`
- legacy time-maintenance functions that authorize through a role helper

### RLS and table grants

All inspected public tables have RLS enabled. This is an important positive control.

| Policy classification | Count |
| --- | ---: |
| Total current policies | 50 |
| Uses effective permission | 4 |
| Contains role reference | 42 |
| Contains role reference without effective permission | 39 |
| Contains both | 3 |

The large role-only policy set is the main database-layer conversion requirement. It covers employees, credentials, sites, posts, events, schedules, shifts, assignments, availability, time events, requests, call-offs, announcements, storage, and related override records.

Supabase table grants are broad by design and rely on RLS. Because the goal is permission-level control, each direct table policy still needs to be rewritten or replaced with a permission-aware RPC boundary. Table grants alone must never be treated as authorization.

### Function and schema grants

- `anon` and `authenticated` have no usage on the `private` schema. Private functions granted to `PUBLIC` are therefore not directly reachable by those roles, but the grants should still be tightened for defense in depth.
- Four public functions currently show explicit `anon` execute grants: `get_session_context`, `get_employee_removal_preview`, `get_removed_employee_ids`, and `admin_remove_separated_employee`.
- Each of those functions performs an internal authentication or permission check, so the inventory did not find an unauthenticated administrative operation. The grants remain a least-privilege defect and should be revoked from `anon` in the enforcement migration.
- All inspected public tables have RLS enabled; no anonymous table grant bypasses an RLS-disabled public table.

## MFA integrity

The permission catalog knows which permissions require MFA, but MFA enforcement is still partly role-driven. That creates a mismatch when custom roles or individual overrides are used.

The enforcement phase must make MFA depend on the effective permission being exercised, while preserving the account-security setup flow. A role label may guide enrollment messaging, but it must not be the final authorization decision.

## Gap register priorities

The complete register is versioned at [ACCESS_CONTROL_GAP_REGISTER_08-21-2026.csv](./ACCESS_CONTROL_GAP_REGISTER_08-21-2026.csv).

Priority order:

1. Approve the intended permission matrix and protected safety rules.
2. Replace navigation and direct-route role fallbacks with declarative permission policies.
3. Replace client action helpers and Worker fallbacks with effective-permission checks.
4. Convert function and RLS authorization to effective permissions, starting with writes and sensitive reads.
5. Revoke unnecessary `anon`, `PUBLIC`, and direct-table privileges after verifying the RPC/policy paths.
6. Make MFA enforcement permission-aware.
7. Add negative tests proving denied access through direct URLs, UI actions, Worker APIs, RPCs, and tables.
8. Capture a second production snapshot after rollout and compare it with this fingerprinted before-state.

## Acceptance criteria for the enforcement phase

The Full Permission Enforcement item is not complete until all of the following are true:

- Removing a permission removes its navigation item, direct-route access, UI actions, Worker/API operations, RPC operations, and direct table access.
- Granting the same permission through a custom role or person override enables the intended capability without requiring a legacy role name.
- MFA is required when the exercised permission requires it.
- Self-service access remains scoped to the signed-in employee.
- System safety rules remain enforced, including protection against removing the last active Admin and preservation of payroll/audit history.
- Guards and other unauthorized users fail closed at every layer.
- Current six-role behavior remains intact unless the approved matrix intentionally changes it.
- The before/after snapshot comparison has no unexplained access drift.

## Inventory commands

Static repository inventory:

```powershell
pnpm inventory:access
```

Production baseline capture (requires the linked Supabase project and authorized CLI session):

```powershell
pnpm inventory:access:production -- 08-21-2026
```

The static scanner follows create, drop, schema-move, and rename events across migrations. The live snapshot remains authoritative for deployed overloads and platform-created functions.
