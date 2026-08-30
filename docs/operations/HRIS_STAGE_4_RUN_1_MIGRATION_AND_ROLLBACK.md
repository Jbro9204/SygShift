# HRIS Stage 4 Run 1 Migration and Rollback

## Release conditions

The migration may be applied only when:

- the Stage 4 static security validator passes;
- the focused Stage 4 tests pass;
- the full application check passes;
- a before-migration preservation baseline is captured;
- the release gate is confirmed disabled;
- the exact migration is applied without broad migration-ledger repair.

## Production verification

After application, verify:

- exactly six private HR document buckets exist;
- all six buckets are non-public;
- the document release gate is disabled;
- no document permission is assigned to any role or employee;
- employee, identity, role-assignment, role-permission, and override counts are unchanged;
- the application continues to build and existing production routes remain available.

## Recovery strategy

The migration is dormant and additive. The safest immediate rollback is to keep the release gate disabled; no user workflow depends on these tables or buckets.

Do not drop document tables or buckets after any document has been stored. Once data exists, recovery must use a forward migration that preserves versions, scan evidence, access history, retention state, and legal holds.

Before any future release enables document access, capture and verify:

- database backup and restore evidence;
- storage-object recovery evidence;
- scanner outage behavior;
- access revocation behavior;
- release-gate emergency shutdown;
- cross-module preservation checks.

## Migration ledger rule

Reconcile only migration `20260830043000` after its transaction succeeds and its production verification passes. Do not repair unrelated migration entries.
