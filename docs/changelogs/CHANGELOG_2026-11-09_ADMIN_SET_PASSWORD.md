# November 9, 2026 — Admin-chosen passwords (staged)

Status: local implementation and synthetic verification. Not deployed; no live employee credential, permission, Auth session, email, or payroll record was changed.

## Requested behavior

- A verified Admin chooses the employee password.
- The assigned password has no expiration.
- A separate checkbox chooses whether the employee must choose their own password at the next new login.
- Existing accounts, roles, MFA policy, disabled state, bans, schedules and hours are preserved. Setting a password does not reinstate access.

## Canonical database work

The forward migration `20261109182242_admin_chosen_password_next_login.sql` adds service-only begin, finish and status readers for one explicit employee password-set request. It builds on the staged verified-password foundation, not on the rejected expiring recovery-code flow.

Only non-secret operation metadata is retained. The provider receives the password directly from the protected Worker; SQL, audit events and operation history do not receive or persist the password or its digest. A request can claim the provider write once. Lost or ambiguous provider results remain unconfirmed and cannot trigger a blind second write.

The protected provider operation UUID is committed with the password in the same Auth transaction. GoTrue actually issues two SQL updates: password first, then metadata. The fence links exactly one earlier password-transition receipt from that same transaction rather than assuming both fields change in one SQL statement. A metadata-only request or an unrelated earlier password change is not proof. Original receipts and the operation mapping are immutable.

Final release review corrected retained-marker handling: a terminal operation removes only its transient Auth metadata marker, preserving its immutable private receipt and every unrelated metadata field. A later ordinary password-and-metadata recovery therefore does not look like a replay. Reusing the closed operation UUID still rejects and rolls back the stale password update. Finalization uses the provider/cancellation Auth-user-before-operation lock order.

An explicit, freshly verified Admin can confirm a saved result from this receipt without repeating the password write. If no write was committed, an explicit cancellation closes the pending request so a new deliberate attempt is possible. Cancellation locks the Auth user before its operation, matching the provider's lock order. A late provider transaction then fails its metadata fence and rolls back its password, session cleanup and receipt together. There is no automatic cancellation or credential expiration.

Individual next-login requirements are independent of the disabled company-wide campaign feature. The ordinary-user path returns before looking up Auth sessions when no requirement exists. Enrolled accounts fail closed for a missing or invalid session; existing valid sessions created before the request remain outside a newly requested checkpoint.

The Admin-assigned password transition does not satisfy the employee's requirement. A separate, later actual password-change receipt is required. Unchecked requests clear only the target's prior change requirements and legacy flag, and only after a confirmed password update. Known provider rejection cancels only the staged request; suspension and bans remain unchanged throughout.

Supabase Auth revokes the selected employee's sessions when an Admin updates their password. The database does not separately revoke other employees or reinstate any session; the selected employee must sign in again. This provider behavior is not a promise that their already-open session remains usable after the password itself is replaced.

## Verification

The native loopback PostgreSQL harness loads the SygShift foundation, Sygilant session projection, this new forward migration and Sygilant's individual access-boundary migration with synthetic identities. The combined matrix covers Guard AAL1 launch/MFA preservation; exact Admin identity and recent proof; secret rejection from SQL; once-only provider claim; missing/old/new sessions; assigned-password exclusion; actual later completion; unchecked requests; known failures; uncertain outcomes; disabled-account preservation; and private immutable audit events.

All 23 scenario groups passed in the final native PostgreSQL run. The actual cross-application functions cover owner-only Data API rejection, exact self-identity/completion allowlisting, restrictive Storage/Realtime denial, and restored access after a verified personal password change. A no-enrollment check runs while the synthetic Auth session table is unavailable, proving this new helper does not reintroduce a universal session lookup. Native two-connection races cover both provider-first and cancellation-first ordering, including rollback of a late provider's session cleanup. Tests also reject replay of a completed operation after an employee chose a new password, reject metadata-only/cross-transaction receipt attribution, and preserve ordinary self-password changes and metadata updates. These are isolated local tests with zero production connections.

The pinned Node.js 24.19.0 / pnpm 11.25.0 local `release:verify` passed: TypeScript, lint, 2,551 application tests (one intentional skip), 216 release-tool tests (one intentional skip), all 42 desktop/mobile Time Clock browser tests, production build and static assets. The final dedicated Worker/password subset also passed 20 tests, including disabling new assignments while retaining existing-request resolution. Production artifacts were rebuilt after the browser tests.

The coordinated Sygilant suite passed 427 files / 4,299 tests, plus its production build and source/security checks. Cross-app boundary, interface and rollout evidence is documented in Sygilant `docs/changelogs/CHANGELOG_2026-11-09_ADMIN_CHOSEN_PASSWORD.md`. No local test constitutes a live Auth-provider canary or approval to enable company-wide password changes.

## Rollback and rollout

Clean release-candidate follow-up: the actual cross-app native run passed 24 scenario groups after the marker correction. The standalone canonical CI mode passed 22 groups with an explicit local prerequisite contract; it does not claim to test the Sygilant-owned boundary. `test:password-native` is now included in `release:test`, alongside the manual-password release preparer regressions. The focused Worker, Account Security and AppShell subset passed 75 tests; Worker type checking and lint passed. The full clean candidate gate must be rerun before release.

Optional `SYGSHIFT_ADMIN_SET_PASSWORD_CANARY_EMPLOYEE_ID` restricts new password assignments and the displayed enabled state to exactly the designated test employee while configured. Missing or mismatched targets cannot begin a provider write; malformed configured identifiers fail closed. Existing status, confirmation and cancellation remain available outside that canary and when new assignments are disabled. No production flag or credential was changed during these tests.

Deploy the canonical password-set and matching Sygilant boundary migrations before exposing this option. Keep the UI/Worker feature off until the release and designated-account tests pass. Do not revert to an unverified password-completion routine, enable company-wide campaigns, clear protected access state, or send recovery emails as part of this release.
