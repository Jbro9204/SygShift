# Security and External Integration Readiness — 09/11/2026

## Decision summary

This run completed the read-only discovery portion of the longer security and integration program and
implemented only the low-risk repository and response-header controls that can be verified without
changing an employee login, account, role, permission, schedule, timecard, payroll record, or vendor
connection.

| Workstream                          | Decision                      | Production effect                                                                                                                                                         |
| ----------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependency and source security      | Proceed                       | Patched the high-severity React Router advisory and added automated audit, regression, CodeQL, and dependency-update gates.                                               |
| Static-page response headers        | Proceed                       | Added Cloudflare Static Assets headers matching the Worker boundary so page and asset responses are not left outside the intended policy.                                 |
| Microsoft 365 calendar and meetings | Adopt in controlled phases    | No connection or consent was created. Begin with delegated calendar visibility, then event-backed Teams meetings only after tenant approval.                              |
| Dialpad                             | Adopt a narrow first phase    | No connection was created. Begin with authenticated launch and approved call/status events; keep embedded browser voice/video separate.                                   |
| Duo                                 | Defer                         | No login or MFA change. Existing Supabase identity and MFA remain authoritative. Revisit only as a protected-role pilot after the core security program.                  |
| Indeed                              | Defer direct integration      | No applicant data moved. Partner API access, terms, retention, and recruiting ownership are required before a direct connection.                                          |
| Enterprise security program         | Continue in controlled stages | Discovery exposed concrete next actions, but secret rotation, edge policy changes, data backfills, and security-provider activation require separate controlled releases. |

## Repository and production observations

- The repository is public. Current source and tracked-file scans found no service-role value, database
  password, private key, or environment file. Environment and private-key patterns remain ignored.
- The Worker has ten encrypted production secret bindings. Only binding names were inventoried; no
  secret values were read, printed, copied, or changed.
- The production dependency audit identified one high-severity React Router advisory affecting the
  previously locked 7.18.1 dependency. The release candidate uses 7.18.2 and the production dependency
  audit now reports no known vulnerabilities.
- The Worker already produced CSP, HSTS, anti-framing, MIME-sniffing, referrer, browser-capability, and
  cross-origin headers for Worker-handled routes. Static application responses were asset-first and did
  not receive those headers. A native Cloudflare Static Assets \_headers file now applies the matching
  boundary without forcing every asset through the Worker.
- SygShift uses legitimate dynamic inline style attributes for document placement, progress, clocks,
  labels, and signature previews. The policy permits inline style attributes only; it does not permit
  inline or evaluated scripts.
- Production database lint found twelve legacy function-definition errors. They affect HR workflow job
  enqueueing, identity backfill, licensing employee upsert, imported-person promotion, two Sygilant
  disposition functions, HR draft saving, HR escalation enqueueing, onboarding pre-hire creation,
  Patrol route linking, Patrol hit saving, and HR operational actions. They are recorded for bounded,
  function-specific forward migrations and regression tests; this discovery run did not rewrite them
  together or touch operational data.
- Unauthenticated GitHub API access could not confirm repository-level secret scanning, push protection,
  or branch protection. Those settings require an authenticated owner review. A repository security
  workflow and Dependabot configuration are included so supported checks start from reviewed source.

## Microsoft 365 calendar and meeting architecture

Recommended phased design:

1. Use Microsoft Entra authorization-code consent and keep Microsoft tokens server-side and encrypted.
2. Begin with opt-in delegated calendar access. Use Calendars.ReadBasic for availability/basic calendar
   display when sufficient; use Calendars.Read only when full event fields are required.
3. Request Calendars.ReadWrite only for users who authorize SygShift to create or update calendar
   events.
4. Create Teams meetings as Outlook calendar events with isOnlineMeeting enabled and the
   teamsForBusiness provider. This preserves the event in Outlook and exposes the join URL to SygShift.
5. Use delta queries or change notifications for incremental synchronization. Store provider IDs and
   sync cursors, not duplicate authoritative calendars.
6. Keep SygShift scheduling and staffing authoritative. Outlook remains authoritative for the external
   calendar event, and a failed sync must never alter a SygShift shift or timecard.

Required before activation: Entra tenant/app ownership, redirect origins, consent policy, Microsoft 365
license confirmation, privacy/retention approval, token-revocation and disconnect behavior, rate-limit
handling, a non-production tenant, and a named canary.

Official references:

- https://learn.microsoft.com/en-us/graph/outlook-calendar-online-meetings
- https://learn.microsoft.com/en-us/graph/permissions-reference
- https://learn.microsoft.com/en-us/graph/auth-v2-user
- https://learn.microsoft.com/en-us/graph/delta-query-overview

## Dialpad architecture

Recommended first phase:

1. Register one company-owned OAuth application and use authorization code with PKCE. Keep refresh
   tokens and client secrets server-side.
2. Add an authenticated SygShift launch/deep-link for approved employees rather than attempting to
   replace the Dialpad calling client.
3. Add only approved signed event subscriptions for call status and messaging events. Validate webhook
   signatures, timestamps, replay protection, employee mapping, and delivery retries.
4. Keep call recordings, transcripts, and retention in Dialpad unless a separately approved restricted
   SygShift data boundary is built.
5. Treat browser-native SygSphere voice and video as a later WebRTC project with its own media,
   recording, emergency-calling, consent, device, accessibility, and support requirements.

Existing Dialpad service may reduce the need to buy a second calling platform, but exact API features,
meeting availability, and cost depend on the company plan and contract and must be confirmed with the
account owner.

Official references:

- https://developers.dialpad.com/docs/oauth
- https://developers.dialpad.com/docs/authentication-basics
- https://developers.dialpad.com/docs/event-subscriptions
- https://www.dialpad.com/pricing/

## Duo recommendation

Decision: Defer.

Duo supports a standards-based OIDC authorization flow and Universal Prompt, but inserting it now would
create another authentication dependency while the existing Supabase password, authenticator MFA,
recent-authentication, recovery, FIDO2 pilot, and shared-identity paths are still the authoritative
system. If reconsidered, Supabase must remain the single employee identity. Duo should be a
feature-gated additional check for explicitly approved protected roles, never a parallel directory or a
replacement for current recovery.

Published Duo editions currently list Free for up to ten users, Essentials at $3 per user per month,
Advantage at $6, and Premier at $9, subject to current terms and purchasing rules. Contract, support,
privacy, outage, device-enrollment, and recovery impacts still require owner acceptance.

Official references:

- https://duo.com/docs/oauthapi
- https://duo.com/editions-and-pricing

## Indeed recommendation

Decision: Defer direct API activation and retain controlled manual/CSV intake as the fallback.

Indeed documents Job Sync, Candidate Sync, Disposition Sync, Employer Registration, and related partner
APIs. Access is provisioned through the Indeed Partner program and is not a general anonymous employer
API. Before a prototype, SygShift needs a recruiting owner, Partner Console access, approved data-use
terms, candidate consent/retention rules, duplicate prevention, field mapping into the existing
Recruiting foundation, deletion handling, and a non-production applicant set.

Official references:

- https://docs.indeed.com/
- https://docs.indeed.com/api-guides/

## Security program baseline and next release order

1. Owner-only control review: GitHub secret scanning/push protection/branch rules, credential inventory,
   Cloudflare WAF and rate-limit plan, incident owners, backups, and rotation authority.
2. Credential rotation release: rotate one dependency chain at a time, validate, then revoke the former
   value. No bulk untested rotation.
3. Database hardening release: repair the twelve lint findings as bounded migrations with allow/deny,
   rollback, and operational preservation tests.
4. Edge protection canary: rate limits and managed WAF rules in log/simulate mode, then one route family
   at a time.
5. Identity/session review: revocation, device/session inventory, recent-auth boundaries, recovery, and
   privileged actions without changing ordinary employee login.
6. Data classification, recovery exercises, alerting, incident response, access certification, and an
   independent review against NIST CSF 2.0, CISA Secure by Design, and OWASP ASVS 5.0.0 Level 2.

References:

- https://www.nist.gov/cyberframework
- https://owasp.org/www-project-application-security-verification-standard/
- https://www.cisa.gov/sites/default/files/2023-06/principles_approaches_for_security-by-design-default_508c.pdf
- https://developers.cloudflare.com/waf/rate-limiting-rules/
- https://developers.cloudflare.com/workers/configuration/secrets/

## Preservation boundary

This run does not rotate or reveal a credential; change a password, MFA method, security-key pilot,
session, login route, role, individual grant/denial, employee status, schedule, timecard, punch, payroll
record, document, message, task, client, Patrol record, or Sygilant identity. It does not authorize a
Microsoft, Dialpad, Duo, or Indeed tenant.
