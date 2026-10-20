# Shift timestamp audit repair

Date: 10/19/2026

Status: database-only repair installed and verified from source `257eda82378b44e80f60bee5eb4c59c5b9b63f73`, pushed to origin/main before activation. Installed writer hash, owner/ACL/configuration and all 104 attachments match the reviewed result. Audit count 313,694 and shift count 64,629 were unchanged after activation.

The existing shift timestamp trigger changes updated_at even when business values do not change. The generic writer consequently appends a complete audit row for these timestamp heartbeats. The narrow repair skips only future public.shifts UPDATE audit inserts where updated_at differs and the entire remaining OLD/NEW JSON is equal. All 23 current business columns, future business columns, other tables, identical final rows, INSERT and DELETE remain audited. No historical row is deleted, changed, moved or hidden.

Migration `20261019232727_suppress_shift_timestamp_only_audit.sql` requires the exact baseline writer, owner, ACL, empty search path and all 104 enabled/definition attachment signatures. Before writer MD5 `b71cc8d34713424231da43820bc94c1e`; repaired writer MD5 `0144a3e9b68e95d5abc10d9ba9b377aa`. Separate forward recovery `20261019233511_recover_shift_timestamp_audit_writer.sql` restores the prior writer only from the exact repaired state; it preserves applied history and cannot recreate omitted meaningless heartbeat rows.

The restored real draft-shift workflow, exact 24-column isolated writer matrix covering every business field, timestamp NULL transitions, added JSON business field, other tables, complete before/after evidence, INSERT/DELETE and identical final rows passed. Hosted rollback installation, contextual trigger lint, security/104-attachment preservation, three drift-refusal cases and exact ledgered release/recovery rehearsals passed. Production shift/history mutation tests remain blocked by the approved maintenance boundary and were not bypassed. Full main quality gate passed 2,204 tests/378 files and 74 release-control tests; actual-component Time Clock checks passed 42/42.

This changes no payroll formula, punch, schedule business value, identity, permission, maintenance feature or notification record. Detailed release fingerprints and limitations: `docs/work-orders/2026-10-19-overnight/SHIFT_AUDIT_TIMESTAMP_REPAIR.md`.
