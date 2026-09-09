# Password Recovery, Last Activity, and SygSphere Popover Repair

Date: 09/09/2026

## Outcome

The signed-out password-reset path is available on the live SygShift application without a blank
screen, Last Activity now comes from a completed SygShift security checkpoint instead of the
authentication provider's premature password timestamp, and SygSphere message-action popovers close
when the employee clicks or taps elsewhere.

## Password Recovery

- Preserved the canonical first-party `/password-recovery` flow from commit `9a3df0a`.
- The emailed link exchanges its single-use token on a stable, eagerly loaded route, removes the token
  from browser history, opens the password-completion checkpoint, and signs out the temporary recovery
  session after the new password is saved.
- The Login page's **Forgot password?** control opens the complete username-based request form.
- Missing, malformed, used, and expired tokens render an explicit safe failure with a return-to-sign-in
  action; they do not leave an empty application shell.
- Added permanent desktop/mobile browser coverage for the signed-out request form and the reset-link
  failure boundary.

## Last Activity

- Stopped the Admin directory from treating `auth.users.last_sign_in_at` as a completed SygShift
  login. Supabase advances that provider field after the primary credential and before SygShift's
  required password-change and MFA checkpoints.
- Added an inaccessible private completion ledger keyed by the live Supabase auth session.
- A native login is recorded only when all of these are true:
  - the JWT belongs to a live `auth.sessions` row and an active linked employee account;
  - the JWT authentication methods include a current password proof;
  - no required password change remains; and
  - MFA is either not required or has been satisfied through the approved SygShift verification path.
- A shared SygSphere launch uses a separate `sygsphere_` RPC and must also carry its bound, unexpired
  shared-identity assertion.
- Account, employee, auth-session, and shared-session rows are locked while admission is checked and
  recorded. Concurrent tabs and retries remain idempotent, and an older session can never move Last
  Activity backward.
- The client keys recording to the auth session, retries only transient failures with a bounded
  backoff, aborts retries on unmount/sign-out, and never records a password-recovery session.
- Account activation remains on its existing lifecycle and was not changed. Historical activity was
  not guessed or backfilled; an account without trustworthy application-owned activity will show no
  completed sign-in until its next validated SygShift session reaches the updated application.

## SygSphere

- Reaction and More message menus now close on outside mouse click or mobile tap.
- Opening one menu closes the other.
- Re-clicking the trigger toggles it closed, Escape closes it and restores trigger focus, and choosing
  an action closes the menu without clearing the message draft.
- Reply, Bookmark, reaction, pin, edit, delete, copy-link, live-message, notification, and composer
  behavior were preserved.

## Production Changes

- Source commit: `32109da`.
- Database migration: `20260910030000_completed_sign_in_activity.sql`.
- Cloudflare Worker: `8550606d-a554-452c-b6c0-3aea68ec49f4`.
- Pre-release rollback tag:
  `rollback/password-recovery-last-activity-sygsphere-pre-release-20260909`.
- The migration was applied from an isolated history that previewed exactly this one forward migration.

## Verification

- Final synchronized release gate: TypeScript, zero-warning application lint, 209 test files /
  1,048 tests, and both production builds passed.
- Combined Password Recovery, SygSphere, and Time Clock browser gate: 74/74 desktop/mobile checks passed.
- Required post-deployment Time Clock preservation gate: 38/38 desktop/mobile checks passed, including
  early-clock-in acknowledgment, active break/clock-out controls, real punch transitions, ambiguous
  shift selection, read-only permissions, and rapid duplicate prevention.
- Live `/api/v1/health` returned HTTP 200.
- Live `/api/v1/ready` returned `ready: true`.
- Live `/login` and `/password-recovery` returned HTTP 200 and loaded the exact deployed
  `/assets/index-DWjPS5Ig.js` bundle.
- Visual live-browser checks confirmed the full Forgot Password form and the visible invalid/expired
  reset-link state. The live reset page produced no warning or error console messages.
- Production migration history contains `20260910030000`; the new completion functions produced no
  database-lint finding. Existing unrelated legacy lint findings were not modified in this release.

## Acceptance Limit

Automated tests cover valid single-use token exchange, password submission, forced recovery-session
sign-out, and fresh-login return. The live mailbox token can only be completed by the employee who owns
the approved email address. The most recently generated reset email should be used; an older or already
used link will correctly show the safe invalid/expired screen.

## Rollback

The Worker can be restored to the tagged pre-release source without touching schedules, punches,
payroll, tickets, messages, or employee records. The database change is additive. During a rollback,
keep the completion table and RPCs in place until the older client is live; only then should the
directory read source and additive objects be removed in a separately reviewed forward migration.
