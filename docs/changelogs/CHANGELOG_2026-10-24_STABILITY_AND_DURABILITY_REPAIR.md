# SygShift stability and durability repair — 2026-10-24

## Release status

- Status: release candidate completed, verified, and rehearsed against a disposable production-data branch.
- Production status: **not deployed**. No production database rows, payroll records, punches, schedules, identities, permissions, clients, licensing records, or audit history were changed by this work.
- Branch: `codex/stabilization-repair-2026-10-24`
- Starting commit: `0533a7d881a42a1e19446976926fbdf2efd22832`
- Deployment, commit, and push: not yet performed at this checkpoint.

This candidate is a coordinated durability repair. Database migrations, Worker behavior, and the web client are designed to be released together. Older Workers and partially migrated database states fail closed; they must not be mixed in production.

## User-visible corrections in the candidate

### Session and account safety

- User-specific query and session state is cleared on sign-out and account changes.
- Cached data is fenced to the authenticated account so one user's stale response cannot overwrite another user's page.
- Shared-identity callback and recovery flows fail closed when identity cannot be verified.
- Password-reset administration is bound to the exact employee, auth user, actor, operation, and recipient before a recovery link is created.
- Personal-email verification uses a deterministic, operation-bound token while storing only its hash; retries reconcile the same operation instead of creating competing authority.

### Schedule and My Time navigation

- Historical Schedule selections remain selected during in-app navigation, browser-tab switching, focus changes, and background refreshes in the same signed-in session.
- My Time and Schedule retain independent selections.
- Current-period controls continue to return each page to its current period.
- Saved user-specific selections are discarded after sign-out or an account change.
- Displayed dates and requested data are kept aligned.

### Schedule notifications

- Manual schedule-notification actions have durable operation identities and truthful success/failure feedback.
- Retries reconcile the original operation instead of silently creating duplicate notices.
- Recipient decisions are frozen once delivery begins.

### SygSphere

- The existing group/channel message acknowledgment capability was verified: acknowledgment is explicit, remains separate from read receipts, is stored per message and authenticated user, and does not add chat messages.
- Read-receipt writes retry safely and the interface no longer presents an unverified save as completed.
- Conversation refreshes preserve authoritative state instead of replacing it with a stale response.
- Direct-message, own-message, deleted-message, and permission boundaries remain enforced.

### Time and payroll views

- Late responses from a prior account or prior request can no longer replace the current payroll view.
- Refresh failures remain visible rather than presenting stale data as newly verified.
- This repair does **not** change payroll policy, pay rates, punches, schedule attribution rules, overtime rules, or calculation formulas.

### Alerts and status truth

- Operational alert age/expiry decisions use a single clock source.
- Expired alerts are removed from active presentation instead of lingering indefinitely.
- Loading, unavailable, failed, and verified states remain distinct in affected pages.

### Documents, reports, and protected files

- Client, licensing, HR, profile-photo, signature, and generated-report operations now use durable operation identities and authoritative completion records.
- An object preserved after an interrupted completion can be reconciled without blindly uploading another copy.
- Storage deletion is fenced to the exact bucket, object, checksum, size, owner, and operation where applicable.
- Failed cleanup work uses bounded leases, exact result receipts, retry limits, and quarantine instead of endless or destructive retry loops.
- Report refreshes and row identities are stabilized so stale responses do not masquerade as current results.
- These reliability changes do not claim to replace, remap, or visually repair every legacy PDF/form in the document library. That broader document-content overhaul remains a separate verified initiative.

### Email and push delivery

- Email delivery uses a frozen recipient manifest, per-recipient durable dispatch identity, token-fenced outcomes, exact replay receipts, and manual-review evidence for ambiguous outcomes.
- Security-key added/removed notices are now claimable without consuming an attempt merely for claiming the job.
- Reconciliation is bounded and source-scoped; unbounded historical sweeps were removed.
- Required document notices do not become suppressible through ordinary employee preference filtering.
- Automated known-unsent releases preserve truthful nullable actor attribution.
- Push subscriptions are fenced to their current authenticated owner.
- Provider outcomes are recorded durably so ambiguous responses are reviewed rather than blindly resent.

### Administrative and onboarding operations

- Login-instruction, onboarding, and admin security actions use operation-bound durability and retry reconciliation.
- Employee password-reset completion requires the exact accepted durable email dispatch.
- Identity drift between preparation and completion returns a conflict instead of resetting the wrong account.
- HR document uploads and employee-file state are fenced to the authoritative employee and operation.

## Database migrations included

The release candidate adds these ordered migrations:

1. `20261024151000_harden_client_document_upload_completion.sql`
2. `20261024153000_durable_email_recipient_dispatch.sql`
3. `20261024154500_harden_licensing_document_upload_completion.sql`
4. `20261024155000_signature_completion_reconciliation.sql`
5. `20261024156000_durable_push_provider_outcome.sql`
6. `20261024157000_licensing_availability_recovery_and_email_source_ids.sql`
7. `20261024160000_profile_photo_upload_idempotency.sql`
8. `20261024161000_bind_hr_document_upload_intent.sql`
9. `20261024163000_protected_storage_artifact_recovery.sql`
10. `20261024164000_hr_document_authority_fence.sql`
11. `20261024165000_stabilize_operational_report_row_identity.sql`
12. `20261024166000_licensing_document_authority_fence.sql`
13. `20261024168000_durable_admin_security_operations.sql`
14. `20261024169000_quarantine_protected_storage_cleanup_retries.sql`
15. `20261024170000_quarantine_document_cleanup_retries.sql`
16. `20261024171000_durable_admin_login_instructions.sql`
17. `20261024172000_durable_manual_schedule_notifications.sql`
18. `20261024172500_fence_push_subscription_ownership.sql`
19. `20261024173000_durable_email_queue_claims_and_review.sql`
20. `20261024174000_protected_storage_cleanup_claim_receipts.sql`
21. `20261024175000_bind_admin_password_reset_identity.sql`

Companion SQL regression scripts were added for upload idempotency, cleanup/quarantine, admin operations, schedule notifications, push ownership/outcomes, HR and licensing authority, report identity, signature/profile storage, and protected cleanup receipts.

## Verification completed

The exact required command `pnpm release:verify` completed successfully on Windows with Node.js 24.19.0 and pnpm 11.25.0.

Final results:

- TypeScript project build/type-check: passed.
- Oxlint with warnings denied: passed.
- Vitest: 408 test files passed, 1 intentionally skipped.
- Vitest assertions: 2,463 passed, 1 intentionally skipped.
- Release-discipline and release-tooling tests: 183 passed, 0 failed.
- Time Clock Playwright workflows: 42 passed across desktop and mobile Chromium.
- Production Worker/client builds: passed twice as required by the release command.
- Static-asset contract: passed.
- Main release-discipline validation: passed.
- Consolidated critical durability suite: 149 passed.
- Patch whitespace validation (`git diff --check`): passed.

A stale source guard found during the first full run was corrected to verify the authoritative frozen-recipient decision, including a recovered existing manifest. Its focused suite passed 6/6 before the full gate was rerun. A transient first-start timeout in the local Playwright fixture was reproduced separately; all 42 workflows passed, and the exact full release command then passed from start to finish.

### Production-copy database rehearsal

The exact 21-migration bundle and all 14 companion SQL regressions completed successfully inside one rollback-only transaction on an ephemeral Supabase PITR branch copied from production. The rehearsal used the production schema, extensions, migration ledger, and production-shaped data without persisting any candidate changes.

The rehearsal exposed and corrected rollback-test-only assumptions involving existing queue depth, prior document versions, explicit JWT sub-claim state, and preexisting security artifacts. Runtime and migration protections were not weakened. After success, the branch still had the original 386 migration-ledger rows, zero candidate migration rows, and none of the new relations. The copied-data branch was then deleted, and only the production main branch remained.

## Release constraints and remaining limitations

- This candidate is not safe to activate piecemeal. Apply the reviewed migrations in order before activating the matching Worker and client.
- Run the database migration-ledger/non-drift gate before production mutation.
- Do not rotate the Supabase service-role key while a personal-email verification operation is ambiguous inside its approximately one-hour verification window. A dedicated versioned verification secret is a recommended follow-up.
- Factor-only MFA reset/recovery-code regeneration remains intentionally unavailable in this candidate rather than presenting a false or unsafe recovery path.
- Ambiguous provider outcomes stay in a review/reconciliation lane; the system does not guess that an email or push was sent.
- Quarantined cleanup work requires authorized review; it is not deleted speculatively.
- Protected-storage cleanup should receive hosted rehearsal for an ambiguous object-delete transport response and a claim/delete authority race before activation.
- The build reports existing large-chunk optimization warnings; they do not block correctness but remain a performance follow-up.

## Required production cutover

1. Re-run the complete release gate from the exact candidate tree.
2. Commit and push the candidate, then require the exact-source CI and CodeQL checks to pass.
3. Run the migration-ledger/non-drift gate and capture the exact source commit.
4. Schedule a maintenance window and prevent mixed-version operation.
5. Apply the reviewed database migrations atomically.
6. Re-run catalog, constraint, trigger, RLS, hosted lint, protected-fingerprint, and error-signature checks.
7. Deploy the matching Worker and client through the existing guarded release path.
8. Verify `/api/v1/health` returns 200.
9. Verify `/api/v1/ready` returns 200 with `ready=true` and `consecutiveFailures=0`.
10. Confirm the source-commit check and the first normal scheduled-runtime cycle.
11. Run targeted canaries for session/account switching, historical date retention, schedule notifications, SygSphere acknowledgment/read receipts, protected uploads, reports, admin password reset, email delivery, push ownership, and cleanup reconciliation.
12. Re-run read-only production integrity checks and monitor new error signatures before ending maintenance.

Rollback must use the existing guarded lifecycle process. Do not reverse individual migrations or rewrite protected business records manually.
