# SygShift FIDO2 Hardware Security Key Pilot

**Date:** 08/29/2026  
**Category:** Security, Identity & Account Protection  
**Release scope:** Controlled `jbrown`-only production pilot

## Outcome

SygShift now supports a physical FIDO2/WebAuthn security key as an optional phishing-resistant MFA factor after the normal username-and-password step. The existing authenticator application remains enrolled and available as the fallback. No user outside the pilot allowlist receives a new prompt or a change to current login requirements.

## Security model

- Password verification always occurs first.
- A successful physical-key challenge satisfies SygShift's protected MFA boundary; it is not a password bypass.
- The production relying party is `sygilant.us`, and only `https://app.sygilant.us` is accepted as an origin.
- Hardware-key authentication is enabled through a server feature flag and restricted to username `jbrown` for the initial pilot.
- Registration, rename, and removal require a fresh raw authenticator AAL2 session.
- Key-authenticated application sessions are bound to the current Supabase session, expire within 12 hours, and are cleared on sign-out.
- Existing trusted-device behavior remains separate and unchanged.
- Authenticator MFA remains the fallback when the key is missing, cancelled, revoked, or unavailable.

## Employee experience

- Added **My Account > Security > Security Keys**.
- A pilot user can add a physical key, assign a friendly name, view when it was added and last used, rename it, and remove it.
- Plain-language guidance explains that the key replaces the authenticator-code step only when the key challenge succeeds.
- Login prefers the registered key while retaining a visible **Use authenticator instead** option.

## Administrator recovery

- Authorized administrators can view an employee's registered-key status in User Accounts.
- A lost or compromised key can be revoked individually without revealing key material.
- Resetting an employee's MFA also revokes all of that employee's registered keys and active key sessions.
- Registration, rename, verification, removal, administrator revocation, and recovery operations are recorded in the append-only audit history.
- Established recipient-safety rules are used for add, remove, and revocation security notices.

## Database and edge delivery

- Applied `20260829163000_security_key_mfa.sql` for credentials, challenges, sessions, audit operations, and protected-MFA integration.
- Applied `20260829213000_security_key_pilot_controls.sql` for audited rename and administrator-revocation operations.
- Added Worker registration, authentication, listing, rename, removal, administrator inspection, and administrator revocation endpoints.
- Credentials and public-key material remain in the private database schema; the browser receives only limited display metadata.

## Validation

- Type checking passed.
- Lint passed with zero warnings.
- 102 test files and 508 tests passed.
- Worker and client production builds passed.
- Production database functions for rename and administrator revocation were verified.
- Migration history records both security-key migrations.

## Controlled activation

The software release is complete, but the pilot remains intentionally limited. Jordan Brown must perform the physical key ceremony in **My Account > Security** and validate current Chrome and Edge behavior. The authenticator factor must remain enrolled, and the pilot allowlist must not expand until cancellation, fallback, removal, administrator revocation, and MFA-reset behavior have been confirmed with the physical key.
