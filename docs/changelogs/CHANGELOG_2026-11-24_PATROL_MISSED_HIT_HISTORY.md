# Patrol missed-hit history — 11/24/2026

Status: application release candidate. No migration, notification cleanup, or operational record write is part of this change.

- Patrol Overview and Operations show unresolved hits for the last 14 elapsed days. The cutoff uses the stored UTC hit deadline and advances on an open page. Unrecognized deadlines stay in the live queue for review.
- Older hits leave the live queue but remain missed and unresolved. The count stays visible. Expand Older missed hits to search by property, route, guard, or service date (MM/DD/YYYY or YYYY-MM-DD) and browse all matching rows.
- Existing Operations permissions are unchanged. The current manual makeup workflow remains available when its exact source assignment is still available. Moving a row to the older view never assigns, waives, completes, deletes, or dismisses anything.
- All 57 targeted Patrol, route, and data tests passed. The desktop/mobile Chromium replay used synthetic data in light and dark themes, with 42 older hits and both empty and non-empty recent queues. The pre-release production snapshot found 42 unresolved September 29 hits and no recent hits. The actual records and their fingerprint were read without invoking the workspace reconciliation function.
- The normal exact-source, rollback-safe Worker release will recheck the reviewed migration ledger, clock workflow, production health, and release boundary. Production record continuity and authenticated verification limitations will be recorded after rollout.
