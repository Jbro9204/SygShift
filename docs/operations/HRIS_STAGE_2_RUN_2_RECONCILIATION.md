# HRIS Stage 2 Run 2 — Reconciliation Operations

Date: 08/29/2026

## Scope

This run installs service-only deterministic proposal and aggregate reconciliation functions. It does not insert into `private.hr_person_identifiers` or `private.hr_worker_identifiers`, change employees, change permissions, or activate HR functionality.

## Required checks

```powershell
pnpm check:hris-foundation
pnpm check:hris-core
pnpm check:hris-reconciliation
pnpm vitest run src/hrisFoundationGuard.test.ts src/hrisCoreDataArchitectureGuard.test.ts src/hrisStage2ReconciliationGuard.test.ts
pnpm check
```

The reconciliation assertion must report zero blocked mappings and `proposal_ready_backfill_disabled`. Warnings remain review items; they are not silently converted into effective-dated HR history.

## Transaction protection

The forward migration captures employee, role-membership, role-permission, individual-override, person-mapping, and worker-mapping counts before installing the proposal layer. It verifies that all counts remain unchanged before commit.

## Privacy

Do not commit or copy a detailed employee proposal to Git, a Desktop changelog, chat, email, or another unprotected location. Only aggregate counts belong in release evidence. The service-only detail function exists for a controlled Stage 2 Run 3 canary review.

## Recovery

Runtime recovery is to leave every HRIS feature and protected-backfill gate disabled. Do not drop functions or repair migration history. Correct defects through a new forward-only migration. If a blocker appears, stop Run 3 and reconcile it explicitly; never regenerate an employee identity or force a silent match.

## Run 3 prerequisites

Before any protected mapping is inserted:

1. create isolated backup and restore evidence;
2. review aggregate reconciliation and controlled detail output;
3. define a bounded canary and forward recovery procedure;
4. verify server authorization and recent MFA for protected actions;
5. compare employee, role, payroll, licensing, schedule, time, separated-history, and audit invariants before and after the canary;
6. keep HR runtime and browser access disabled until the entire run passes.
