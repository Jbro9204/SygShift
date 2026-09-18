# SygShift Changelog — 09/18/2026

## Sygilant Return Handoff Assurance Repair

### Problem and impact

Employees who had entered SygShift through the approved Sygilant shared-login path could see the Sygilant launcher but received **“Sygilant could not be opened securely. Please try again.”** when they tried to return. The browser sent the valid platform shared-identity proof, and the SygShift workspace correctly treated that proof as completed MFA, but the Sygilant launch Worker did not forward it when revalidating the session against `get_session_context`. The second check therefore downgraded an otherwise valid platform-return session and rejected the launch with HTTP 403 before an assertion was issued.

### Resolution

- Forwarded the existing `x-sygshift-shared-identity` proof through the server-side session-context revalidation used only by the protected Sygilant launch endpoint.
- Preserved database validation of the proof, canonical employee/account checks, effective `apps.sygilant.access` authorization, MFA policy, short-lived HMAC assertion, exact destination allowlist, and single-use consumption.
- Added an end-to-end Worker regression that begins with an AAL1 Supabase token plus a valid platform-return proof, confirms the proof reaches `get_session_context`, and confirms the resulting assertion records `external_mfa` rather than being rejected.
- Strengthened the reciprocal-launch source guard so future edits cannot silently drop the platform proof again.

### Verification

- Focused shared-identity and launcher suite: **4 files / 54 tests passed**.
- Complete release gate: **267 files / 1,349 tests passed**, plus TypeScript, zero-warning application lint, Worker build, and client production build.
- Required actual-component Time Clock preservation matrix: **42/42 passed** across desktop and mobile.
- `git diff --check`: passed.

### Database and security

- No database migration or production-data mutation was required.
- No assertion, shared-identity proof, access token, employee identifier, username, or secret is logged or placed in a URL.
- Employee, account, role, permission, MFA, schedule, punch, payroll, document, and audit records are unchanged.

### Release status

- Source commit, Cloudflare Worker version, live health/readiness, and employee-present launch verification are recorded after production deployment.

