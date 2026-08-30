# HRIS Stage 2 Run 1 — Migration and Rollback

Date: 08/29/2026

## Production change

Migration `20260829230000_hris_core_data_architecture.sql` installs an additive, feature-off Core HR schema. It creates new private tables, constraints, triggers, reconciliation functions, and unassigned permission definitions.

It does not:

- update or delete an employee;
- insert a protected HR person or worker mapping;
- change an employee status, role, login, or individual permission override;
- change Schedule, Time & Attendance, Payroll, Licensing, Availability, or audit records;
- enable an HR route or browser workflow.

## Deployment method

The repository contains older remote-only Supabase migration history. The normal linked migration command correctly stopped instead of attempting to repair or replay that history.

For this run, deployment used a temporary isolated migration workspace containing the known remote history plus only the new Stage 2 migration. A dry run first proved that exactly `20260829230000_hris_core_data_architecture.sql` would be applied. The same isolated workspace then applied that single migration.

No migration-history repair was performed.

## Transaction safeguards

The migration runs inside one transaction. Before creating the new schema it records counts for:

- employees;
- employee role memberships;
- role permission assignments;
- individual permission overrides.

Before commit it verifies that all four protected counts remain unchanged. Any difference aborts and rolls back the transaction.

The successful production commit is therefore evidence that this run preserved existing employee and access-control rows. The remote migration record also confirms that the single Stage 2 migration completed.

## Verification commands

Run from the repository with the approved bundled Node and pnpm runtime:

```powershell
pnpm check:hris-foundation
pnpm check:hris-core
pnpm vitest run src/hrisFoundationGuard.test.ts src/hrisCoreDataArchitectureGuard.test.ts
pnpm check
```

The Stage 1 gate must remain closed and the Stage 2 contract must continue reporting:

- feature disabled;
- protected backfill disabled;
- role mapping disabled;
- browser access disabled.

## Rollback and recovery

The safe runtime rollback is to keep the feature disabled. Because this run creates an empty dormant schema and no application route uses it, current SygShift operations continue independently of the new tables.

Do not drop these tables or delete their history after later runs begin writing records. Any correction must use a new forward-only migration. If a defect is found before backfill, leave the schema unused, document the defect, and supersede it with a forward migration.

Before Stage 2 protected backfill can begin, the next runs must provide:

1. an exported reconciliation proposal with no silent matches;
2. isolated backup and restore evidence;
3. authorization and recent-MFA tests for every protected action;
4. a canary backfill with employee, access, payroll, licensing, schedule, time, and audit comparisons;
5. an approved forward-recovery migration plan.

## Operational stop conditions

Stop a later Stage 2 run immediately if it would:

- create a second employee identity;
- alter current roles or access without an explicit approved mapping;
- overwrite effective-dated history;
- introduce duplicate or unresolved employee mappings;
- modify payroll, schedule, time, licensing, or separated-employee history;
- expose private HR tables to the browser.
