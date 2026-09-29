# Patrol Assignment Link Repair

Date: 09/29/2026
Status: Production database repair applied, source pushed, and endpoints verified

## Outcome

Patrol management can again link an active versioned route to the exact
employee assigned to a published Schedule shift. The repaired database function
creates the intended Patrol assignment and that route version's scheduled hit
obligations without confusing its local assignment identifier with the
obligation table's `assignment_id` column.

Three intended live assignments now exist:

- Joseph Lee — **MG Properties Patrol** version 7 — 11 scheduled obligations.
- Anthony Herman — **Tamarac Apartments Hourly Patrol** version 1 — 8
  scheduled obligations.
- Fernando Gomez — **Patrol hits (not MG properties)** version 3 — 23
  scheduled obligations.

The production total is 42 Scheduled obligations, 0 completed, and 0 missed.
These records establish the live work plan; they do not represent completed
field service.

## Production incident and root cause

At 14:14:27 UTC on 09/29/2026, production returned PostgreSQL SQLSTATE `42702`
when Patrol management attempted to link a route to an employee's published
shift.

`public.link_patrol_route_shift(uuid, uuid, uuid)` declared a local
`assignment_id` variable and also referenced the
`patrol_hit_obligations.assignment_id` column in an `ON CONFLICT` target.
PL/pgSQL could not determine which identifier the conflict clause meant, so the
function failed while inserting the new assignment's obligations.

## Repair

- Added forward-only migration
  `20260929143310_patrol_assignment_variable_ambiguity_repair.sql`.
- Renamed the local value to `patrol_assignment_id` and returned the inserted
  assignment through an explicit `patrol_assignment` table alias.
- Replaced the ambiguous column-list conflict target with
  `ON CONFLICT ON CONSTRAINT patrol_hit_obligations_unique DO NOTHING`.
- Preserved the public function signature, `SECURITY DEFINER` boundary, empty
  controlled `search_path`, explicit authenticated grant, current-employee and
  effective-permission checks, MFA requirement, active-route and published-
  shift validation, exact shift/employee matching, armed-route protection,
  route-local service date, immutable route-version link, idempotent
  obligation creation, and audit event.
- The migration replaces only the function definition. It does not rewrite
  existing routes, assignments, obligations, hits, evidence, schedules,
  attendance, timekeeping, payroll, or audit history.

## Database verification

- Migration source and production migration ledger both identify version
  `20260929143310`.
- The exact migration and rollback-only regression passed together in one
  rehearsal transaction with one outer `BEGIN` and one final `ROLLBACK`.
- The installed production function passed the same rollback-only regression
  after migration application.
- The regression verifies the installed function contract, fixed search path,
  execution grants, denied unauthenticated-identity access, denied AAL1 access,
  authorized AAL2 assignment creation, exact employee selection from a shared
  shift, two expected obligations, stable idempotent retry, audit evidence, and
  preservation of Schedule assignment, call-off, attendance, and time-event
  counts.

## Application verification

- Focused Patrol coverage: **2 files / 14 tests passed**.
- Full repository gate: `pnpm check` passed with **334 files / 1,766 tests**, as
  well as strict TypeScript, zero-warning lint, and the production build.
- Mandatory Time Clock preservation: **42/42** actual-component desktop/mobile
  checks passed.
- Production management then created the three intended assignments and 42
  scheduled obligations listed above. No obligation was represented as
  completed or missed.

## Release record

- Migration: `20260929143310` applied and recorded.
- Source commit: `e7043b535b49269338cc6e307b9369eb4ded9865`.
- Push confirmation: the implementation push advanced `origin/main` from
  `0adecc0` to `e7043b5`; this release-record commit followed it.
- Cloudflare deployment: Not required; no browser or Worker code changed.
- Production health/readiness: `/api/v1/health` returned `status: ok`; `/api/v1/ready`
  returned `status: ready`, `ready: true`, and every required binding check
  true.
- Desktop archive copy: synchronized from this completed release record to
  `C:\Users\Jordan\Desktop\SygShift Changelogs` after Git publication.

## Remaining limitations

This repair clears the assignment-link database failure but does not make
Patrol fully field-accepted. Management must still verify remaining route
addresses and canonical client/site relationships. Joseph's field acceptance,
completed-hit and missed-hit evidence, supported photographs, normal and
longer incident-style videos, upload interruption/retry, preview, download,
retention, report/export, and cross-scope media authorization remain open.

The three assignments and 42 Scheduled obligations must not be described as
completed Patrol work. TrackTik remains in service until the broader source
reconciliation and field/media acceptance criteria are approved.

## Rollback and operator notes

The migration is forward-only. If another database correction is required,
replace the function through a new migration rather than editing the applied
file. Preserve the three live assignments, their 42 obligations, route-version
links, and audit history. Do not delete operational records to roll back the
application surface.
