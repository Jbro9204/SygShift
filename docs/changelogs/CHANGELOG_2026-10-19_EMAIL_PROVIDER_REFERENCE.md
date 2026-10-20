# Preserve accepted Email Sending references

Date: 10/19/2026

Status: Prepared on the notification review branch; no production deployment, database change, or provider send.

Verified that deployed source uses Cloudflare's structured native Email Sending binding, whose [official contract](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/) returns an opaque `messageId`. The helper discarded it and always audited a NULL provider reference.

The forward code change preserves returned accepted IDs in the existing audit field for inline and deferred deliveries, with no transport, credential, schema, or RPC contract change. IDs are never inferred. Missing/invalid IDs and rejected sends retain NULL references. Welcome API delivery JSON remains unchanged.

Inline audit failures now preserve provider acceptance instead of misclassifying it as an email failure. Deferred processing retains terminal-marker-before-audit ordering so another cycle cannot resend an accepted message because its audit failed. Audit failures emit a sanitized signature without recipient addresses or provider IDs. Failed audit persistence remains an evidence gap; no historical ID is reconstructed and the stranded broadcast remains unsafe to replay.

Validation passed: focused provider-reference/suppression/Worker suites (97 tests); full `pnpm check` (381 files and 2,241 tests passed, one existing skipped file/test; TypeScript, lint, 95 release tests, build, and static assets passed); all 42 required actual-component Time Clock browser checks; and a fresh post-browser build. Independent source review found no actionable issue. All sends and RPCs in the new regressions were mocked.

Technical evidence and limits are saved in `docs/work-orders/2026-10-19-overnight/EMAIL_PROVIDER_REFERENCE.md`. The candidate remains held behind the existing provider-outcome and normal production release gates.
