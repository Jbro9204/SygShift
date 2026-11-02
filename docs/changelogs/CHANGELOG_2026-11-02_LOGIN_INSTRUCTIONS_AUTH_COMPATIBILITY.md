# Login instructions and Auth directory compatibility repair

Date: 11/02/2026. Application: SygShift; shared Supabase Auth compatibility.

## Verified cause

The reported welcome email succeeded, but both login-instructions attempts stopped before account creation. Supabase Auth logs at 21:14:59 and 21:15:04 UTC show `GET /admin/users` returning HTTP 500 / `unexpected_failure`: the `banned_until` column could not be scanned into the Auth service's timestamp type. There was no Auth account-create request in that incident window.

Read-only inspection identified exactly one positive-infinite `auth.users.banned_until` value. Its linked employee account was independently disabled. The other Auth timestamps, target RPC shape, canonical login alias, and configured password policy were valid. The current supported Security Center ban writers already use a finite `876000h` duration; no current application writer of the infinite value was found. Its historical origin remains unestablished.

This was a shared account-directory read failure, not a failed welcome email, a missing invitation permission, or a reason to disable MFA, change usernames, or lower password requirements.

## Applied operational repair

Used a reviewed, fingerprint-gated one-row operational repair, not a schema migration. Replaced only the unreadable ban representation with one fixed future timestamp using the existing canonical 876000-hour policy. The independent disabled state remains intact. Credentials, all other Auth fields, employee/account/central access records, roles, permissions, sessions, MFA, schedules, punches, payroll, reports, and previous audit records were not modified by the repair.

The repair appends exactly one minimal audit receipt preserving the original `infinity` value, replacement, reason, request reference and private-manifest checksum. It does not copy credential records into the audit trail. Replaying the same request verifies the existing receipt without extending the ban or appending duplicates.

The first rollback rehearsal safely timed out before any update because full historical-table preservation hashing exceeded the unchanged five-second limit. Independent readback confirmed the original row and zero repair receipts. The final renderer replaces those scans with PostgreSQL's current-transaction write counters: exactly one Auth update and one audit insert are permitted, with no other table writes. These are backend-local counters, not global statistics, so concurrent employee activity is not mistaken for repair activity.

The revised production rehearsal passed and rolled back. Separate readback verified all original target/access fingerprints, the infinite value, disabled state, zero repair receipts, and unchanged migration count. Only then was the exact reviewed activation committed. The two SQL files differed only at the final rollback/commit boundary; lock timeout remained two seconds and statement timeout five seconds.

Final activation SHA-256: `83c8dc40b99ffd29fc0a1b118bd7b624492a768d0b39e0d8093ec6b82dfa610b`. Canonical private manifest SHA-256: `52f7aa7b372aacad54bc2bc5dfc16e13319069853921b2e9844d8fc31118566f`.

Independent postflight passed: the same real Auth directory request changed from HTTP 500 to HTTP 200, returning 92 valid user records; the ban remains finite, future and exactly as reviewed; the account remains disabled; all protected fingerprints are unchanged; one exact audit receipt exists; all 14 Auth timestamp columns are free of non-finite values. All 442 migration entries, including prior historical evidence, remain unchanged. No employee invitation was submitted to manufacture this result. PostgreSQL may allocate an audit sequence value during a rollback rehearsal; such harmless gaps are not rewound.

## Application hardening

- Login instructions expose safe stage-specific failures and an opaque request reference for target lookup, Auth lookup, creation/update, account linking and email confirmation. Raw provider errors, private identities, passwords and tokens are not logged or displayed.
- Validate login-only target and Auth response contracts. Preserve existing linked Auth IDs and legacy email aliases; new-account confirmation must match its intended alias. Active-employee eligibility and all existing authorization/MFA checks remain unchanged.
- Validate bulk target batches before any provisioning. Cache one Auth lookup promise per administrative request, including failures, preventing a directory outage from causing one repeated provider request per employee. A later deliberate request performs a fresh lookup.
- Prevent duplicate email taps and competing actions, disable automatic mutation retries, and refresh account status after success or failure. Failed readback requires an explicit read-only refresh rather than another send.
- Keep Welcome and Login Instructions outcomes independent. Show provider acceptance, not proof of delivery, and do not infer account preparation from an error.
- Add a count-only, fail-closed release check for provider-incompatible ban timestamps. It runs during release preflight, not normal employee login, and never automatically alters security state.
- Document the finite-ban contract in `docs/SECURITY.md`. No managed Auth triggers, constraints, indexes, or permanent helper objects are added.

## Verification and files

Product files: `worker/index.ts`, `src/data/adminUsers.ts`, `src/pages/UserAdminPage.tsx`. Release guard: `tools/database-release-gate.mjs` and tests. Operational preparation/isolated regression: `tools/auth-ban-serialization-repair.mjs`, its unit tests, and `tools/auth-ban-serialization-postgres-regression.mjs`; `pnpm test:auth-ban-repair` connects only to a disposable loopback fixture. The renderer itself never connects to a database and defaults to rollback-only output. Private manifests, row identifiers and generated production SQL remain outside Git in ignored operator artifacts.

- Full `pnpm check`: 402 application test files / 2,492 tests passed, one intentional skipped file/test; strict TypeScript, zero-warning lint, production build and static-asset validation passed.
- Release-control suite: 216 passed, one skipped, zero failed.
- Targeted Worker/client/rendered UI checks: 145 tests passed. Dedicated actual-component browser fixture: 8 desktop/phone checks passed, including safe failure references, readback, duplicate prevention, partial outcomes, close/reopen and viewport containment.
- Repair renderer: 9 unit tests passed. Native PostgreSQL 18.3 fixture: 16 scenarios passed, including fingerprint/cohort/disabled-state rejection, actual rollback, exact-write postflight, concurrent-backend exclusion, credential/business/access preservation and idempotent replay.
- Independent production database release gate accepted the unchanged 442-entry baseline, 101 retry-safety checks and the new finite-ban check after the repair.

## Release status, rollback and remaining confirmation

The operational data repair is applied and verified. This source snapshot is the application release candidate: exact-main push quality, all 42 mandatory Time Clock browser checks, final promotion and live asset verification must be recorded in the operator closeout before claiming the UI/Worker enhancements deployed. No maintenance window or shutdown is required.

No dedicated authenticated release-canary credentials are configured. The owner has been asked to approve the documented anonymous boundary-probe fallback for this invite-repair release; the earlier MFA-only approval is not silently broadened.

The reported employee still has no linked Auth account and no login-instructions delivery audit entry. A deliberate authorized retry is needed; no password reset, real invitation, repeated Welcome email or test account was created during this investigation. Explicit login-instructions sends retain their established temporary-password behavior; this release does not introduce a durable cross-provider idempotency/outbox redesign or claim inbox delivery.

Application rollback uses the preceding reviewed Worker version. Retain the verified finite-ban repair and audit evidence: restoring the invalid infinite value would restore the shared Auth outage. Any later security-state change must use the canonical Security Center authority, not this one-off compatibility tool.
