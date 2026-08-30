# HRIS Stage 8 — Talent, Learning, Cases, Safety, and Assets

## Release state

Stage 8 is installed as a dormant production foundation. It does not change current employee, role, permission, schedule, timekeeping, payroll, licensing, document, or authentication behavior.

Each module requires both its database release gate and Worker feature flag. All five database gates and all five Worker flags are disabled by default. No Stage 8 permission is assigned to a role or person by this release.

## Protected modules

### Talent

- Goal cycles, employee goals, performance reviews, development plans, restricted talent records, and append-only events.
- Permissions: `hr.talent.view`, `hr.talent.manage`, and `hr.talent.restricted`.
- Performance or employment decisions remain human decisions. Automation may organize work but cannot silently create an adverse result.

### Learning

- Learning categories, learning items, employee assignments, completion evidence, Licensing Center connections, and append-only events.
- Permissions: `hr.learning.view`, `hr.learning.manage`, and `hr.learning.assign`.
- Licensing remains authoritative for credentials and shift eligibility. Learning connections reference that authority instead of duplicating it.

### Employee Cases

- Restricted cases, participants, factual notes, follow-up tasks, protected evidence, and append-only events.
- Permissions: `hr.cases.view`, `hr.cases.manage`, and `hr.cases.restricted`.
- Recent MFA is required in addition to exact permission checks.

### Safety

- Safety cases, witnesses, work restrictions, return-to-work records, restricted medical records, and append-only events.
- Permissions: `hr.safety.view`, `hr.safety.manage`, and `hr.safety.restricted`.
- Recent MFA is required in addition to exact permission checks. Medical information remains isolated from ordinary incident information.

### Assets

- Asset inventory, assignments, employee acknowledgments, transfers, returns, financial reviews, and append-only events.
- Permissions: `hr.assets.view`, `hr.assets.manage`, and `hr.assets.approve`.
- Asset assignment records can support onboarding and offboarding without changing the authoritative employee identity.

## Access and data boundaries

- Browser roles cannot query private Stage 8 tables directly.
- The Worker verifies the operations session, exact effective permission, feature flag, and database gate before returning any module data.
- Employee Cases and Safety also require recent MFA at both the Worker and database boundaries.
- Case, safety, and talent records use the secure document platform for attachments. Stage 8 does not create a second document store.
- Event and acknowledgment evidence is append-only.
- Worklists are server-bounded and the interface offers only 5, 10, or 20 records per page.

## Controlled activation

Activation is a separate production change. For one module at a time:

1. Approve the operating policy, record owners, retention rules, and restricted-data boundary.
2. Complete backup and recovery evidence.
3. Assign the minimum exact permissions to named test users; do not grant broad access by convenience.
4. Enable the module's database release gate.
5. Enable the matching Worker flag.
6. Create a small, non-sensitive canary record set.
7. Verify authorized, unauthorized, stale-MFA, mobile, audit, document, pagination, and rollback behavior.
8. Record the activation and evidence in the release changelog.

Turning on only one gate must not activate a module.

## Rollback

Disable the Worker flag and database gate for the affected module. Do not delete protected records or reverse append-only evidence. Confirm current SygShift Schedule, Time & Attendance, Payroll, Licensing, User Accounts, and employee access remain unchanged.

## Release checks

- `pnpm check:hris-talent-learning-cases-safety-assets`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm build`
- `pnpm build` produces and validates both the Worker and client production bundles.
