# SygSphere Message Acknowledgment

Date: October 19, 2026
Status: Released and verified in production

## Outcome

SygSphere group conversations and channels now provide an explicit per-message **Acknowledge** action. Employees can confirm an instruction without adding “copy” replies to the conversation. The message shows the authenticated employee's saved state, a count, and the acknowledging identities to authorized conversation participants.

Direct messages intentionally retain their existing read-receipt and reaction behavior without the instruction-acknowledgment action.

## Behavior and compatibility

- Viewing or reading a message never acknowledges it.
- Repeated taps and network retries are idempotent for the same message and employee.
- Acknowledgments are stored separately from read receipts and reactions.
- All historical check-mark reactions remain ordinary, visible, removable reactions. New clients no longer offer a check mark in the reaction picker, preventing ambiguous new use.
- Editing an instruction clears its earlier acknowledgments and records that invalidation in the protected audit trail; the message revision remains preserved.
- Removed participants cannot fetch message acknowledgment identities or create acknowledgments.
- The action, count, identity panel, error state, and retry path work across mobile and desktop layouts; acknowledgment controls use the 44-pixel mobile touch-target floor.
- The existing message stream, membership rules, notification behavior, and message history remain unchanged.

## Database boundary

- Forward migration: `20261019130405_sygsphere_message_acknowledgment`
- Dedicated private relation: `private.sygsphere_acknowledgments`
- The authenticated browser can use only the existing participant-gated `public.sygsphere_request` boundary; direct table access and direct private-helper execution remain revoked.
- The release fails closed if either reviewed production SygSphere function differs from its verified pre-release hash.
- Production contained 14 historical check-mark reactions before release. The design deliberately leaves every one unchanged instead of converting it into acknowledgment evidence.

## Verification before activation

- The migration rollback-only rehearsal passed against the linked production database and left no schema, helper, or ledger residue.
- The combined install-and-forward-recovery rehearsal passed. It restored the exact reviewed pre-release function hashes, removed the acknowledgment mutation helper, retained acknowledgment and audit evidence, and left no production residue after the outer rollback.
- An isolated Supabase history comparison found exactly one pending migration (`20261019130405`) and zero missing remote versions; its dry run selected only that migration.
- SQL parsing passed for the migration, regression, recovery, recovery regression, and all generated release transactions.
- Focused SygShift acknowledgment UI coverage passed: **1 file / 8 tests**.
- Full `pnpm check`: **377 files passed / 1 skipped; 2,173 tests passed / 1 skipped**, plus strict TypeScript, zero-warning lint, production Worker/client builds, and static-asset validation.
- Mandatory desktop/mobile Time Clock workflow: **42/42 passed**.

## Release and fallback checkpoints

- Pre-acknowledgment SygShift source tag: `rollback/pre-sygsphere-message-acknowledgment-20261019`
- Pre-acknowledgment Sygilant source tag: `rollback/pre-sygsphere-message-acknowledgment-ui-20261019`
- Forward database recovery: `supabase/recovery/20261019130406_sygsphere_message_acknowledgment_recovery.sql`
- Recovery is forward-only: it restores the exact earlier API functions and disables new acknowledgments while retaining the private acknowledgment rows and audit history for diagnosis or a later repair.
- No rollback path deletes messages, read receipts, reactions, acknowledgments, audit records, or identities.

## Production activation

- SygShift source commit: `9a185e2bcd59697d3443f6f7e545916ba91a3d41`
- Cloudflare Worker version: `3909afa1-b032-4505-ad55-e61329e55336`
- Sygilant source commit: `e18141fa9b414f139b0bf99d6227fc5a4acfb2f8`
- Cloudflare Pages deployment: `1ecfbbe9-ac17-4ce4-bd22-89c946f15808`
- Full SygShift quality gate: **passed**
- Mandatory Time Clock matrix: **42/42 passed**
- Full Sygilant product/source/lint/build gate: **passed**. Four unrelated, pre-existing Windows CRLF-sensitive text assertions remain documented; the involved files were unchanged and the assertions pass after LF normalization.
- Production database activation and the installed rollback-only regression passed. Migration `20261019130405` is ledgered; the private table and helper are installed; all 14 historical check-mark reactions remain unchanged; the regression left zero acknowledgment and zero acknowledgment-audit rows; Supabase Security and Performance Advisors report zero errors; and the changed SygSphere functions have zero database-lint errors.
- `app.sygilant.us` and `sygshift.sygilant.workers.dev` returned `200` for the application, health, and readiness endpoints. Their live index and all 10 referenced assets matched the accepted local build exactly.
- Authenticated production verification confirmed the explicit action in a private team channel, no action in a direct conversation, no action on the signed-in author's own messages, and preservation of an existing check-mark reaction. No acknowledgment or synthetic production chat record was created during verification.
- The Sygilant custom domain and immutable Pages deployment returned `200` for the root, password-recovery, SygSphere, and health routes. The full production deployment checker passed on the custom domain, and authenticated production verification confirmed the compatible action, zero-count state, and separation from reactions and read receipts.
