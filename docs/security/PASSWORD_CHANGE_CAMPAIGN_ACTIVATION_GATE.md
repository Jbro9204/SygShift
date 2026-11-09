# Password-change campaign activation gate

Status: staged, not deployed or enabled. No employee enrollment, email delivery,
password reset, session revocation or company-wide rotation is authorized by this
document.

## Foundation

Migration `20261109154616_password_change_requirements_and_verified_completion`
installs a private, default-off campaign configuration, explicit Admin-controlled
preview/create/list/cancel functions, and an account/session-scoped requirement.
Creation does not set `employee_accounts.must_change_password`: that established
flag remains the onboarding/explicit credential-replacement checkpoint. New
requirements apply only to Auth sessions created at or after the selected start.
Existing Auth sessions and their refreshes are not enrolled by this mechanism.
This is a planned next-login credential change, not an emergency session
revocation. Compromised-account containment continues to use the separate
Security Center revocation workflow.

New clients complete changes through `mark_password_changed_verified()`. The
legacy `mark_password_changed()` delegates to that same verified implementation
after the migration. A missing new RPC is a closed checkpoint, never a reason to
fall back to an older unverified completion function.

An Auth encrypted-password transition creates an append-only receipt containing
only an Auth user identifier, receipt identifier and timestamp. It stores neither
the password nor its hash. An explicit completion checks a post-requirement receipt
before changing the onboarding flag or request status. Issuing a temporary
password must set the onboarding flag after issuing the credential, so the
temporary credential's own receipt cannot fulfill its first-login requirement.

## Activation is blocked pending direct-access review

`get_effective_permissions()` denies effective-permission-backed operations for
affected sessions, and the canonical emergency context returns the effective
password-change requirement. This is necessary but not an assertion that every
historical direct Data API or SQL function has adopted that boundary.

Retained source includes role/owner-only authorization paths, for example:

- `public.is_admin()` in `202607030001_foundation.sql` and
  `public.is_supervisor_or_admin()` in `20260717110000_critical_production_hardening.sql`
  derive authority from the current application role rather than this requirement.
- The `employee_availability_read`, `employee_availability_insert_own`, and
  `employee_availability_ops_write` policies in the latter migration authorize
  ownership or `current_app_role()` directly.
- A read-only installed-policy check on November 9 confirmed that
  `employee_availability_insert_own` still checks only
  `employee_id = current_employee_id()`. The installed read policy retains an
  ownership alternative, while Operations writes use effective permissions.
  This is a verified remaining boundary gap, not merely an old source example.
- Historical administrative routines in
  `20260930160000_atomic_primary_role_access_profiles.sql` retain explicit
  `is_admin()` branches. Their installed definitions and dependent policies must
  be resolved against later migrations before making a live coverage claim.

Do not fix these by replacing `current_employee_id()`, suppressing the whole
session context, or adding blanket per-table policies during this feature. Those
changes could interfere with identity resolution and operational workflows. The
campaign feature must remain off until an exact installed-function/policy audit
and negative-authorization tests establish the intended boundary.

## Required release and activation evidence

1. Both applications propagate the canonical flag, fail closed on unsupported
   completion, and preserve normal Guard sign-in without imposing new MFA.
2. Approved synthetic/controlled tests cover direct SQL/API denial, the old-session
   exception, new interactive sign-in, and shared-launch session behavior.
3. Provider password-change and receipt capture are tested together; unrelated Auth
   updates and login refreshes must not count as a credential replacement.
4. Scheduled activation handles time zones/DST and does not disrupt existing
   clock-ins, drafts, reports, payroll or ongoing shifts.
5. Campaign preview lists exact targets and exclusions; submit requires the same
   eligible count; no partial enrollment or silently expanded audience is accepted.
6. Owner separately authorizes activation and the first named canary. Wider batches
   remain separate actions after confirmation of the canary's actual login.

## Reversibility

The private feature flag defaults to false. A separately authorized flag-off
operation stops enforcement of campaign requirements without removing the
underlying request/evidence history. It does not clear legacy onboarding flags,
restore disabled accounts, change credentials or reinstate sessions. Keep the
verified completion path and receipt history intact when rolling back the UI.

## Local verification

`node tools/password-change-postgres-regression.mjs` starts an isolated loopback
PostgreSQL cluster, loads synthetic identities and the migration, then shuts the
cluster down. It does not read production connection strings or application secret
files. The focused UI suite is `src/pages/AccountSecurityPage.test.tsx`.

Local tests are not production activation evidence.

The Sygilant-owned session projection is separately versioned as
`20261109155422_password_change_session_projection.sql`. Install the SygShift
foundation first. The isolated regression accepts that migration path as its
optional first argument to test the actual cross-application projection without
duplicating its SQL in this repository.
