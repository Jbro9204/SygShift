# Shared-Session Outage Hardening

Date: 10/11/2026  
Status: Implemented and verified; awaiting deployment

## Incident

Production returned `503` from `POST /api/v1/auth/shared-identity/session` while Supabase reported
`Timed out acquiring connection from connection pool`. The shared-session bridge treated every restore failure as
revocation, cleared its protected HttpOnly cookies, and the browser then cleared its in-memory identity and routed
the employee to sign-in. A temporary database-capacity failure could therefore destroy an otherwise valid session.

The application and both health endpoints recovered before this repair was prepared. This change hardens the
failure path so a repeat transient outage does not sign employees out.

## Repair

- Preserve the protected shared-session cookie when restore fails because of a network timeout, HTTP
  `408`/`425`/`429`, or an upstream `5xx` response.
- Return `Retry-After: 2` on retryable shared-session failures while retaining the same generic external error body.
- Continue clearing the session only when the Worker confirms absence/revocation with `204`, `401`, or `403`, or
  when the browser receives a successful but invalid session envelope.
- Keep explicit sign-out destructive even if revocation or configuration services are unavailable.
- Stop converting transient token refresh, auth-user verification, local-identity lookup, and scoped-session RPC
  failures into expired or revoked sessions.
- Make exactly one Worker restore request per browser recovery cycle, then use capped exponential backoff with
  per-browser jitter while honoring `Retry-After`. Successful end-to-end session-context recovery cancels the
  pending retry and resets the backoff; explicit deterministic Worker `502`, configuration, and other terminal
  contract failures do not enter a retry loop, while generic gateway `502` responses remain recoverable.
- When Supabase rotates a single-use refresh token and a later verification step temporarily fails, return the
  newly encrypted HttpOnly session cookie with the retryable response so the next attempt does not reuse the
  invalidated refresh token.
- Preserve an already-open workspace during transient restore or session-context failures. On initial load, retain
  the protected sign-in and show the secure-access verification state until recovery instead of redirecting to
  login.
- Preserve authenticated sessions on the Login and Account Security pages during transient session-context
  failures and present an explicit retry action rather than signing the employee out.
- Classify failed fetches, connection-pool timeouts, retryable PostgREST codes, and HTTP `408`/`425`/`429`/`5xx`
  session-context failures as transient. Permission denials and invalid response contracts remain terminal.

## Security boundary

- No access token or shared bearer was moved into browser storage.
- The shared token and Supabase session remain memory-only; the session envelope remains HttpOnly, Secure, and
  same-site protected.
- Invalid, expired, revoked, wrong-origin, wrong-scope, and malformed successful responses still fail closed.
- No database schema, RLS policy, migration, employee record, schedule, timekeeping, payroll, or notification data
  changed.

## Regression coverage

- A strict single-use refresh-token sequence followed by `has_scoped_shared_identity_session` returning `PGRST003`
  / `504` produces a retryable `503`, includes `Retry-After`, does not emit `Max-Age=0`, sets the rotated protected
  cookie, and succeeds after recovery without reusing the invalidated token.
- Auth-user `503` follows the same cookie-preservation path.
- Browser restore makes one request per cycle, preserves the in-memory session after a `502`, `503`, or network
  failure, computes jittered exponential delays with a 60-second cap, honors `Retry-After`, and does not retry a
  non-transient `404`, explicit deterministic Worker `502`, or deterministic configuration failure.
- Recovery backoff advances when Worker restoration succeeds but session-context loading remains transiently
  unavailable; it resets only after the entire restore and account-context cycle succeeds.
- Worker-confirmed `401` and `403`, missing-cookie `204`, and invalid successful envelopes still clear local state.
- AppShell keeps active shared sessions mounted during transient restore and session-context failures without
  signing out or clearing the server session.
- Login and Account Security regressions confirm transient session-context failures preserve authentication, show
  a retry state, and recover without calling sign-out.
- Session-context tests distinguish connection-pool/network failures from a real `403` rejection.

## Verification

- Final focused regression suite: 6 files and 75 tests passed, including the exact PGRST003 connection-pool
  scenario, generic gateway `502` recovery, strict single-use refresh rotation, Login and Account Security
  preservation, explicit-logout behavior, and multi-cycle backoff progression.
- Strict TypeScript passed.
- Zero-warning application and Worker lint passed.
- Final `pnpm check` passed: 369 test files passed / 1 skipped and 2,105 tests passed / 1 skipped, followed by the
  production Worker/client builds and static-asset contract.
- The mandatory desktop/mobile Time Clock workflow passed 42/42 after the final diff, followed by a fresh
  production build and static-asset validation.
- Independent final review found no remaining release blocker.

## Release boundary

No deployment, production configuration change, database migration, or GitHub publication was performed as part of
this hotfix preparation. Production promotion requires the normal reviewed release workflow.
