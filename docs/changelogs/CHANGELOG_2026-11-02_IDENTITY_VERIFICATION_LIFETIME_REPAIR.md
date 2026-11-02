# Identity verification lifetime and permission-denial repair

Date: 11/02/2026. Application: SygShift. No site restyling.

## Verified defects and scope

The application-wide identity-verification coordinator retained one pending checkpoint and cross-tab completion state without binding them to the authenticated employee, provider session, active client, or originating page. Its permanently mounted host did not cancel a checkpoint at sign-out or account change. A delayed privileged response could therefore show a checkpoint over a later Guard session or Schedule page, and an old modal callback could complete a newer request.

Two Worker permission-denial branches also returned MFA-required codes after assurance had already passed: User Administration authority and notification-processing authority. Retrying MFA could not supply those missing permissions.

Read-only production review confirms the reported Guard account's effective policy does not require MFA and it has no enrolled factors. The five Schedule read RPCs and their three reviewed helpers match their owning source, including the known forward removal of an obsolete role fallback. Normal self-schedule reads do not invoke the verification coordinator. This establishes real lifecycle and error-classification defects; it does not prove which exact screen or request caused the employee's historical prompt. No employee-specific exception is added.

## Repair

- Bind checkpoints and automatic retries to the active Supabase client/reference and kind, user, provider session, local lifecycle generation, page, and access generation. Decoded claims fence browser work only; they never establish server authority.
- Cancel pending checkpoints on sign-out, account/session change, route change, or invalidated access generation. Reject late initial identity bootstrap and responses rather than adopting a replacement account or page.
- Scope Web Locks and BroadcastChannel completions to the same identity/session; validate completion shape, method, freshness and request identifier. No tokens or MFA grant are persisted by the coordinator.
- Key the host/modal by an opaque request ID; late verification/cancel callbacks cannot resolve a replacement request. Bind verification-method side effects and interrupted upload retries to their captured origin.
- Preserve same-session refresh/MFA upgrades, genuine protected-action verification, existing enrollment and security-key management rules, and the single-retry limit.
- Return distinct `admin_users_permission_required` and `notifications_permission_required` codes for the two verified authority denials. Status remains 403; genuine MFA-required branches are unchanged.
- Preserve the established handling of ambiguous legacy SQL messages that combine permission and MFA requirements. Disambiguating those database contracts is not included in this release.

## Files and verification

Product files: `src/lib/identityVerificationCoordinator.ts`, `src/components/IdentityVerificationHost.tsx`, `IdentityVerificationModal.tsx`, `AppShell.tsx`, `src/data/auth.ts`, `hrDocuments.ts`, `mfa.ts`, `securityKeys.ts`, and `worker/index.ts`.

Regressions cover account and client changes, sign-out, initial-session bootstrap, stale responses and callbacks, route/access-generation changes, concurrent prompts, same-session refresh, cross-tab resolution, late security-key persistence and authenticator refresh, genuine MFA versus permission denial, existing enrollment, document recovery, and Shell cache teardown. Fixtures use synthetic identities and no production authentication or records.

- Focused coordinator/host/method/auth/document suites: 10 files / 106 tests passed.
- Worker-focused suites: 5 files / 104 tests passed.
- Shell lifecycle regression: 40 tests passed, with all original sign-out/cache assertions preserved. Its mock now models a stable client and multiple real Auth subscribers.
- Actual Host/Modal controlled-browser regression: 16 desktop/mobile Chromium checks passed. This is not a signed-in production Schedule acceptance test.
- Full `pnpm check` passed: 399 application test files / 2,438 tests, one intentional skipped file/test, strict TypeScript, zero-warning lint, release-control tests, production build and static-asset contract.
- Exact-main push quality, mandatory desktop/mobile Time Clock checks and production promotion must pass before rollout is reported complete. The operator closeout records their exact results and source/version identifiers.

## Database preservation and release baseline

No database migration or operational data repair is part of this change. No identity, role, permission, MFA enrollment, session, schedule, punch, payroll, report, rate, or historical audit record is edited by this work.

The normal release gate correctly stopped at an unreviewed newer Sygilant migration. Read-only reconciliation proved that `20261101004629_report_factual_form_v1.sql` is the already released nine-statement source, with all 441 preceding ledger entries and 573 earlier owning sources unchanged. Its normalized source SHA-256 is `f3cb93e6b0f575e87431c8a8892d1f6c404f5e56796fad33fb72e8eba80a5fa4`; ordered statements SHA-256 is `5907a734193185935564554b115e7284aec822e60858cd58c83d260b928fe35c`.

Added a separate reviewed `docs/reliability/migration-ownership-2026-11-02-v2.json`: 442 applied versions, 410 SygShift sources, 164 Sygilant sources. A second fresh read-only capture has zero drift. All existing reconciliation exceptions remain unchanged; the October 31 baseline is preserved. Live retry safety passes for 101 functions with zero unsafe findings; all 46 protected function/security-metadata fingerprints pass. No migration replay, ledger rewrite, retry-manifest change or gate bypass occurs.

## Rollout, fallback and remaining limitations

Source-commit status: release candidate, not yet deployed at documentation preparation. Use the unchanged exact-main candidate and GitHub quality gates followed by the normal rollback-protected release command and a fresh post-browser production build. The owner explicitly approved the documented anonymous boundary-probe fallback for this MFA release because a dedicated read-only release login is not configured. No maintenance window or employee write pause is required for this code-only change.

Rollback is the exact previous reviewed Cloudflare Worker version recorded by the release gate. No database rollback is needed. Keep server MFA, permissions, emergency revocation and existing data intact.

Signed-in confirmation of the originally reported Guard workflow remains pending. Neither anonymous checks nor synthetic browser fixtures establish that historical incident's precise trigger. Request factories remain responsible for binding their own async credentials and requests; the coordinator fences its challenge/retry lifecycle, not every arbitrary asynchronous operation in the application. The separate onboarding login-instructions failure is not fixed or retested by provisioning a real account in this release.
