# SygShift Secure-Access Browser Recovery Race Repair

Date: 10/30/2026  
Application: SygShift  
Status: release candidate; production deployment and authenticated confirmation pending

## Outcome

Prepared the browser-side repair for valid employees who reached **Secure access is temporarily unavailable** even though the central session and platform-session registration requests had succeeded. The workspace remains fail-closed when verification actually fails or access is explicitly revoked, but overlapping browser lifecycle events can no longer discard a successful verification.

## Verified root cause

Production traces showed the shared-session check completing in 2 ms and the emergency platform-session registration returning HTTP 200 in 99 ms, with every nearby registration also succeeding and no Worker error. The failure occurred after successful server verification but before the browser retained the verified session context.

Four client behaviors combined to create the race:

- focus, online, and visibility events independently requested central revalidation;
- a short-lived `BroadcastChannel` publisher could deliver its own `updated` message to the page's separate subscriber, which then aborted and restarted the successful load;
- one recovery timer represented both shared-cookie restoration and session-context recovery, so an older timer could survive a newer success;
- platform-session registration performed a second Supabase session lookup instead of using the access token already verified by the shell.

## Changes

- Debounced focus, online, and visibility revalidation into one bounded check.
- Kept an already verified workspace mounted while a background authority check is pending.
- Processed received shared-session updates through the existing single-flight queue without aborting the current successful registration or rebroadcasting the received update.
- Split shared-identity restoration recovery from session-context recovery and reset each timer only from its own successful path.
- Made manual retry invalidate the older request generation and both older recovery timers before starting a new verification.
- Passed the shell's verified access token directly to platform-session registration, removing the redundant session lookup.
- Preserved generation checks so an invalidated or late completion cannot overwrite a newer result.
- Replaced the inaccurate hard-coded 12-second recovery explanation with the verified failure reason.
- Retained destructive sign-out only for explicit central revocation or suspension.

## Security and data protection

- A pending background check does not grant access; it preserves only a workspace that already completed central context and platform registration.
- A completed failed verification still closes the workspace and schedules bounded recovery.
- Explicit revocation still clears protected state and ends access.
- No identity, permission, payroll, punch, schedule, licensing, client, message, document, or audit record was changed.

## Database and migration status

No database migration is required. This repair changes browser coordination only and continues to use the existing central emergency-access authority.

## Verification

- Focused secure-access regression suite: 4 files and 51 tests passed on exact Node.js 24.19.0 and pnpm 11.25.0.
- The focused suite covers direct token reuse, explicit revocation, duplicate lifecycle events across separate timer ticks, a received browser-channel update that must not be republished, a redundant refresh while platform registration is pending, independent recovery timers, stale-generation rejection, and manual-retry timer cancellation.
- Background transient and terminal Auth-session acquisition failures are also verified to close previously mounted protected content.
- Full `pnpm check` passed strict TypeScript, zero-warning lint, 390 application test files with one intentional skip, 2,311 of 2,312 tests, 189 release-control tests, the production build, and the static-asset contract.
- All 42 mandatory desktop/mobile Time Clock browser checks passed, followed by a fresh production build and static-asset validation.
- The exact-SHA pre-push release verification, GitHub quality workflow, production health/readiness, exact live asset parity, and authenticated live recovery remain pending for the release candidate.

## Rollback plan

If the application release introduces a regression, restore the immediately previous reviewed Worker version. Do not roll back the centralized database authority or restore the self-aborting browser update behavior.

## Remaining limitation

The controlled multi-application emergency-revocation ceremony remains separate. This release repairs ordinary SygShift browser recovery and does not claim that final ceremony complete.
