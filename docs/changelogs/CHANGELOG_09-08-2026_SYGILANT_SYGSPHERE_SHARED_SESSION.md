# Sygilant To SygSphere Shared Session Release

Date: 09/08/2026

## Outcome

SygShift now accepts a narrowly scoped, one-time launch from Sygilant into the existing `/sygsphere` workspace. The receiving application remains the only SygSphere implementation and continues to own all messages, attachments, presence, search, read state, drafts, realtime delivery, notifications, roles, and permissions.

## Receiver Flow

- Added an exact-origin form receiver for Sygilant launches with a strict body-size and content-type boundary.
- Stored the short-lived assertion only in a Secure, HttpOnly, SameSite=Lax host cookie and never in a URL.
- Added a server-only completion endpoint that introspects and consumes the assertion through Sygilant.
- Revalidated the auth user, employee ID, username, active status, and enabled SygShift account against SygShift's own canonical records.
- Created a Supabase action link only for the existing SygShift auth account and validated the returned verification URL before redirecting.
- Added a callback route that finalizes only with a real Supabase bearer session and removes callback material from browser history.
- Redirected the completed session to the exact `/sygsphere` route.

## MFA And Session Protection

- Added an opaque, hashed protected-session token bound to the employee, auth user, Supabase session ID, and one-time launch request.
- Added the protected token to existing server request headers and cleared it at sign-out.
- Extended the existing server-side MFA predicate to accept only a valid shared session bound to the current user and current Supabase session.
- Preserved a Sygilant trusted-device assurance for no more than its existing 14-day limit.
- Limited fresh authenticator, security-key, and external MFA assurances to the active browser session and no more than 12 hours.
- Ignored external role claims and continued deriving all roles and permissions from SygShift.
- Added independent encrypted consumer and session-signing credentials in Cloudflare.

## Database

- Applied `20260908183000_shared_sygsphere_session_bridge` to production after an isolated dry run confirmed that only the two paired SygSphere bridge migrations would execute.
- Added forced RLS, service-only grants, one-time launch uniqueness, expiry checks, session binding, revocation support, and canonical private audit events.
- Preserved every existing SygShift employee, credential, MFA factor, trusted device, conversation, message, attachment, role, permission, schedule, and time record.

## Verification

- Added receiver tests for disabled-state denial, method, origin, destination, local identity revalidation, mismatch denial, magic-link validation, protected-session issuance, and inherited MFA.
- Added source-level bridge guards and updated protected-route and access-control regression coverage.
- Passed the full SygShift quality gate with 191 files and 936 tests before final release packaging.
- Passed 38 desktop/mobile time-clock workflow checks.
- Passed the SygSphere browser configuration with 60 desktop/mobile checks, including 22 SygSphere scenarios and the time-clock regression set.
- Final deployment and live production evidence is recorded in the verified release entry in `DEVLOG.md`.

## Rollback

- Pre-change provider tag: `rollback/sygsphere-provider-20260908`.
- The receiver can be disabled immediately with `SYGSHIFT_SHARED_IDENTITY_ENABLED=false`.
- Protected shared sessions can be revoked without changing employee credentials or SygSphere data.
- The isolated implementation branch is `feat/sygsphere-sygilant-bridge` until it is promoted to `main`.

## Scope Boundary

- Direct SygShift login, recovery, MFA enrollment, and security-key operation remain available and unchanged.
- This release does not add a general SygShift-to-Sygilant launcher. That reciprocal platform entry remains a separate integration item.
