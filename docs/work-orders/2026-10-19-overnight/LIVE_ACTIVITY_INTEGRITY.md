# Live punch and audit reconciliation — 10/19–10/20/2026

Bounded read-only reconciliation at 10/20/2026 00:13:09 UTC explains the one-row growth between the 23:54:36 UTC preservation snapshot and the installed urgent-maintenance test. Production contains 2,569 punches and 313,695 audit records; the restored production baseline contains 2,568 and 313,694 respectively. No data was removed, frozen or repaired to make those counts agree.

| Evidence | Result |
| --- | --- |
| Original punch set | All 2,568 original complete rows still match the restored baseline multiset SHA-256 exactly: `e985fc19bc78923f2ccc44d5fcece96dd28e50753c83bf1a2e0e863e87156512`. |
| Added punch | Exactly one `clock_out`, source `web`; created 00:03:27.679903 UTC, recorded 00:03:27.682730 UTC on 10/20/2026. Creator and idempotency key are present. |
| Timing | Added after the unchanged 23:54:36 snapshot and before urgent repair activation at approximately 00:05:09 UTC. It was already present in the installed test's before-count map. |
| Added audit | Exactly one `public.time_events` INSERT audit, at 00:03:27.704176 UTC. No other post-baseline audit class was found at this observation. |
| Exact relationship | Audit row key matches that new punch internally; old snapshot is NULL and complete new snapshot equals the stored punch. No raw key or row contents were returned. |
| Actor context | Punch creator is the same employee; audit employee context is the same employee; audit Auth subject maps to that employee's active, enabled account. All checks return true. |
| Urgent installed test cleanup | All 15 before-count keys equal fresh after-rollback counts; zero surviving capabilities, zero rehearsal attendance/call-off rows, one repair ledger row and zero recovery rows. |

These independent facts identify normal operational clock-out activity rather than committed rehearsal residue. The direct comparison of `created_by` with audit `auth_user_id` initially returned false because these fields represent employee and Auth-user identities respectively. The correct existing-account mapping, employee context and complete-row snapshot checks all pass. This is database provenance evidence; it does not claim an observer witnessed the human clock-out or establish every unrelated table's history.

Both baseline and hosted row hashes use UTC, ISO/YMD date formatting, SHA-256 of each complete `row_to_json` record and a sorted multiset aggregate. The restored baseline's latest original punch `created_at` is 10/19/2026 21:03:52.096809 UTC. Filtering production at that exact cutoff yields the same count and full-row hash; the only later-created row is the clock-out above. This proves preservation of the original punch multiset without exporting identifiers or changing records.

The local read-only session verifies its exact loopback host, port and isolated database name. Hosted checks use the pinned official Supabase CLI, `BEGIN READ ONLY`/final `ROLLBACK`, an eight-second statement ceiling and 250 ms lock ceiling. The first CLI attempt failed at login-role initialization with TransportError before executing SQL; the retry and separate actor-mapping check succeeded. No production DDL/DML, provider call, live browser login, backup change or secret output occurred.

Sanitized aggregate evidence and query sources remain in ignored `tmp/overnight-2026-10-19/live-activity-{baseline-local,hosted,actor-check-hosted}.{sql,json}`. Existing protected installed receipts are `backups/overnight-2026-10-19/urgent-maintenance-installed-functional.json` and `urgent-maintenance-installed-cleanup.json`. The production backup and original preservation snapshots remain unchanged.
