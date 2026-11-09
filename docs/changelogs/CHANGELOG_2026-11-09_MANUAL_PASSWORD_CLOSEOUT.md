# Manual password workflow — release closeout
Date: November 9, 2026

## Result
Deployed the administrator-chosen password workflow across the shared SygShift identity backend and Sygilant Security Center. The final manual-action configuration is active for authorized Admins, no longer limited to the designated test account.

Use Sygilant → Workspaces → Security Center → select an employee → Set password. Selecting a name is read-only. An explicit confirmation and current Admin verification are required before a credential is changed.

- The Admin chooses the password; no password expiration is imposed.
- “Require password change at next login” is an independent checkbox.
- No login/recovery email is sent by this workflow.
- No company-wide password-change campaign was enabled.
- Setting a password does not reinstate a suspended account, restore removed roles, change Guard MFA policy, or change hours, payroll, schedules, or clock status.
- Only the selected account's existing Auth sessions are ended by the provider's password replacement.
- Passwords are not stored in application receipts, SQL operation records, logs, or emails. Uncertain writes are resolved by status and explicit confirmation rather than automatic repeat password writes.

## Live verification
The owner privately assigned a password to Test McTester (@tmctester), with next-login change required. The UI and database confirmed the assignment. The later personal password change was independently verified by its receipt and completion event. The owner confirmed successful workspace use in both Sygilant and SygShift.

The test account remained active, Guard-only, and without an MFA requirement. Access, effective-permission, role-assignment, and permission-override fingerprints matched their pre-test values. No other employee received a manual password operation.

The agent directly verified the Admin interface and authoritative receipts. The owner's two Guard-workspace checks were user-reported, not directly observed by the agent. No password was provided to or read by the agent.

A live initial-read issue was also corrected: an Admin needing verification could see only a generic password-availability failure. The panel now handles the exact first-layer and canonical MFA-required responses, offers the existing verification ceremony, and retries only the read-only status request. Other permission denials remain denials. All password-write authority, fresh-proof, idempotency, and receipt checks are unchanged.

## Associated narrow repairs
- Fixed operational-alert retirement of an unassigned generated vacancy without altering published cancellation fields or weakening the published-schedule guard. The existing open-state normalizer is included in the repair and its tests. The natural scheduled cycle closed the retired vacancy; its protected-field fingerprint stayed unchanged.
- Fixed the report preview's early non-bubbling iframe error handling, retaining authorized Open/Download fallback and leaving report contents, versions, approvals and retained files unchanged.
- Hardened only the isolated PostgreSQL test setup for Windows/Linux: loopback TCP, installed-binary discovery, bounded startup diagnostics, and bounded cleanup. No production database timeout or server configuration was changed.

## Verification evidence
- SygShift: 2,556 application tests passed; one existing intentional skip.
- Release-tool tests: 219 passed; four intentional skips. Additional baseline/startup tests: 18 passed.
- All 42 desktop/mobile Time Clock browser checks passed; production artifacts were rebuilt afterward.
- Native password rehearsals: 22 canonical groups and 24 actual cross-app groups passed.
- Integrated alert-retirement checks: 54 passed.
- Sygilant final follow-up: 4,301 tests, TypeScript, lint, production packaging and the full quality gate passed.
- Focused verification-recovery checks: 44 tests and 12 native-workerd scenarios passed.
- Report preview component: 32 checks passed, including an early-error regression shown failing on the prior implementation and passing with the fix.
- Exact-SHA GitHub workflows passed before release.

The shared database release gate accepted the reviewed 457-entry migration baseline and checked 101 retry-safety functions. Historical migration records were not rewritten.

## Deployed versions
SygShift code: 0c2809ee5f9af375936806635a3aadd8c9e0ad75
Final Worker version: 9d275e99-6f25-4f86-82de-0abcc0b4553c
Final Worker deployment: 924058f3-6b51-42d2-95a6-176c47fc223f

Sygilant code: ef4840d9ec816c2da1d0d34d5a7cadebff11a179
Production Pages deployment: 3d83f187-8685-4f9e-9c3b-c687f85e6ecd

GitHub:
- SygShift: https://github.com/Jbro9204/SygShift/actions/runs/42700789441
- Sygilant final follow-up: https://github.com/Jbro9204/Sygilant/actions/runs/42705527720

Final manual availability was promoted at 21:59:29 UTC. Both application health endpoints returned HTTP 200, readiness was true, consecutiveFailures was 0, and the matching-source natural runtime cycle completed at 21:59:57.276 UTC.

Final read-only database check: one manual operation (Test McTester), zero other-employee operations, zero unfinished operations, zero campaign batches, and company-wide campaign enabled=false. The retired vacancy remained closed with its published cancellation data and protected fingerprint intact.

## Rollback and limits
The accepted feature-off Worker version b7e31765-9c50-4c6e-94d1-ec9d41869f03 remains the configuration rollback point. Disabling new assignments must retain status, resolution and personal-change completion for existing operations. Do not restore old password hashes, delete receipts, restore old permissions, or undo operational records.

Wrangler did not supply a candidate preview URL. The approved documented fallback used native/automated checks, anonymous boundary checks, real production health, source verification and natural runtime progression. The unchecked assignment path was covered by automated tests; the live designated-account test used the checked next-login-change path.

The browser extension requested an update during final tab cleanup, after the live Admin view had been verified. No extension or unrelated software was changed.

