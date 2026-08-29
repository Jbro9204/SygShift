# Security baseline

## Access

- Accounts are invite-only.
- Usernames are assigned from the employee directory and mapped to private Supabase Auth identifiers; employees sign in with usernames, not personal email addresses.
- The first administrator is created through a one-time service-role bootstrap command. Bootstrap credentials are never stored in source code, migrations, documentation, or browser-delivered files.
- Temporary bootstrap passwords must be replaced on first sign-in.
- New employee logins are provisioned only through an Admin + MFA server-side workflow. The browser never receives the service-role key.
- Temporary employee passwords are shown or exported once for handoff and must be treated as confidential.
- Privileged roles require multi-factor authentication before sensitive mutations.
- Disabled or separated employees cannot authenticate or accept work.
- Authorization is enforced in the database and server, never only in the interface.
- Administrative changes require a current authenticated account and are audited.

## Data handling

- Service-role and secret keys are forbidden in browser configuration.
- Service-role keys must live only in local secret files, the Cloudflare secret store, or a sealed provisioning process.
- Sensitive site details are stored separately from ordinary site records.
- Sensitive site details are never included in announcement or email bodies.
- Access to sensitive site details is limited to Admins, Supervisors, and guards actively assigned to that location, and access is logged.
- Workbook source files and extracted private data are excluded from Git.
- Logs must not contain credentials, full request bodies, private contact information, or site secrets.

## Browser and edge controls

- Production responses set a restrictive Content Security Policy and permit data connections only to the same origin and Supabase.
- HTML and API responses are not cached; fingerprinted static assets may retain Cloudflare's asset caching behavior.
- Every Worker response receives an opaque request ID for troubleshooting without echoing request content.
- Camera, microphone, geolocation, payment, and USB browser permissions are disabled by default.
- Welcome and login-instruction email delivery requires the effective `admin.users.invite` permission and an MFA-verified session. Hiding the controls in the interface is not treated as authorization; every invitation endpoint enforces the permission in the Worker.
- Login-instruction content is selected from the employee's effective MFA requirement, using the same base-role, assigned-role, and person-specific permission sources as the authenticated session. This prevents privileged employees from receiving incomplete setup instructions and prevents ordinary employees from receiving unnecessary MFA language.
- Onboarding sends no more than one Welcome email and one applicable Login Instructions email per deliberate admin action. Standard and MFA Login Instructions are mutually exclusive.
- Employee delivery prefers a valid personal email address. While company-domain delivery is blocked, `@guardianshipsecurity.net` recipients are excluded in database recipient selection and suppressed again at the Worker provider boundary. A blocked or missing recipient must never trigger account creation or a password reset.
- Framing is same-origin only. A future company hub should mount SygShift on the same origin or add one exact reviewed hub origin; wildcard framing is prohibited.
- Local development omits HSTS and CSP so hot reload works, while retaining the remaining response-hardening headers.

## Hardware security keys

- FIDO2/WebAuthn security keys are an optional phishing-resistant MFA factor. They never replace the account password and never create password-only access.
- Security-key authentication is offered only after a successful username-and-password sign-in and satisfies the same protected SygShift MFA boundary as the authenticator-app challenge.
- The production relying-party identity is fixed to `sygilant.us`, with `https://app.sygilant.us` as the only accepted origin. Preview and `workers.dev` origins cannot register or authenticate a production key.
- The initial release is protected by both a feature flag and an explicit username allowlist. The first pilot is limited to `jbrown`; users outside the allowlist keep the existing authenticator workflow without a UI or policy change.
- Authenticator MFA remains enrolled and available as the fallback during the pilot. A cancelled, absent, unknown, or failed key challenge never falls back to password-only access.
- Key registration, rename, and removal require a freshly verified authenticator session at raw Supabase AAL2. A remembered device or security-key application session cannot authorize key-management changes.
- A successful key challenge creates a browser-session-scoped, server-validated security-key session. It is bound to the current Supabase JWT session identifier, expires after no more than 12 hours, and is cleared during sign-out.
- User verification and a physical authenticator are required. Platform-only passkeys are not accepted during the hardware-key pilot.
- Credential public keys, counters, transports, and credential identifiers remain in the private database schema. The interface exposes only the friendly name, creation date, last-used date, and limited device metadata.
- Registration, rename, successful verification, user removal, administrator revocation, and MFA recovery actions create append-only audit records.
- Authorized User Accounts administrators can inspect registered-key status and revoke a lost key. Resetting MFA also revokes every registered security key and active security-key session for that employee.
- Adding, removing, or administratively revoking a key sends a security notice through the established recipient-safety rules. No email is sent to the temporarily blocked company domain.
- Disabling the feature flag immediately removes the key option while preserving the authenticator path and stored credential records for controlled rollback.

## Workforce rules

- Armed posts require a current armed qualification. The rule applies to visibility, requests, approvals, and direct assignment.
- Schedule publication and payroll locking are privileged actions.
- Timeclock events use server time. Client timestamps may be recorded only as diagnostic metadata.
- Original punches cannot be edited or deleted; corrections are separate amendments with actor, reason, and time.
- Correcting an unlocked payroll-batch assignment requires the effective `time.override_payroll_assignment` permission and an MFA-verified session. The correction requires a reason and creates append-only history without rewriting punch evidence.
- Locked payroll exports and their rows remain append-only. Recalculation skips locked occurrences, and an assignment correction is rejected when the occurrence is already present in a locked export.
- Username reservations are never reused.

## Production checks

- Review all row-level security policies with Guard, Supervisor, Admin, disabled, and unauthenticated test accounts.
- Enable leaked-password protection, rate limits, bot protection, and custom SMTP in Supabase.
- Require MFA for Supervisors and Admins.
- Configure restrictive Cloudflare security headers and rate limits.
- Run dependency, secret, static-analysis, accessibility, and end-to-end checks before release.
- Test restoration from database backup before launch and on a recurring schedule.
