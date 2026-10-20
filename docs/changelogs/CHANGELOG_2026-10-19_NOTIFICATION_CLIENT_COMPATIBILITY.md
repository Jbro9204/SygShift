# Notification reader compatibility and safe delivery handoff

Date: 10/19/2026

Status: Prepared and tested on `maintenance/notification-client-compat-20261019`; held for review. No production deployment or provider call.

The notification terminal-state candidate now gives new clients an explicit `get_notification_center_v2` reader. Already-open browsers retain the legacy response keys and `queued`/`delivered`/`failed` states. Both paginated readers use retry leaves; the separate older zero-argument summary/recent API stays byte-identical. The new reader retains the existing MFA, permission, owner, grants, and search-path boundary.

Independent review also found that the previous backfill could close an in-flight fifth delivery attempt before its valid provider acceptance. The replacement candidate never closes a timestamp-null pending row. It takes a short queue write barrier and rejects unresolved outcomes, including exhausted ambiguous attempts, with a two-second lock/transaction budget. Real uncertain deliveries require provider confirmation before installation; this change does not pause clock or urgent call-off access or authorize a blind resend.

The never-applied proposal is superseded only on this review branch by CLI-generated migration `20261020001825_notification_terminal_state_compatibility.sql`. Guarded reader-only forward recovery `20261020001855` is outside the active migration queue. It preserves terminal metadata, writers, retry generations, both old contracts, and history; a visible notice explains its temporary coarse delivery view. Recovery activation or later restoration of expanded v2 behavior requires a separately reviewed forward version and fresh release gate.

Validation passed:

- Eight grouped local rollback SQL suites, including all three fifth-attempt handoffs, 13 full logical baseline payload comparisons, exact unique-order page JSON, old/new actual parsers, late-result races, child/grandchild retries, permission/MFA denials, and guarded recovery.
- All 930 original queue-row hashes and related audit, inbox, retry, and restored ledger counts remained unchanged after rollback.
- Full `pnpm check`: 380 files / 2,228 tests passed, one existing skipped file/test; TypeScript, lint, 95 release tests, build, and static assets passed.
- Actual desktop/mobile Notification Center checks and all 42 mandatory Time Clock checks: 46/46 passed; screenshots inspected; fresh build after browser checks.

The baseline reader has undefined order for equal timestamps; three comparisons exposed only that pre-existing ambiguity. Complete row values, metadata, timestamp windows, and unique-order pagination matched. The original zero-argument SQL overload ambiguity remains disclosed and unchanged.

The approved maintenance readiness gate, authenticated release canaries, fresh live/hosted validation, and definitive outcomes for ambiguous exhausted delivery records remain required before production activation. Passing local tests does not complete the notification deployment stage. The technical handoff is `docs/work-orders/2026-10-19-overnight/NOTIFICATION_CLIENT_COMPATIBILITY.md`.
