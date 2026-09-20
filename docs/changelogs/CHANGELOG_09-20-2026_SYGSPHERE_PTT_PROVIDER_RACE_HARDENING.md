# SygSphere PTT provider-race hardening — September 20, 2026

## Problem prevented

PTT media setup involves several provider requests. A channel floor can be released, expire, lose its
authorization, or be superseded while one of those requests is still pending. The coordinator must never
store or expose a late provider result as an active transmission.

## Repair

- Added a coordinator-owned preparation lease extension that is limited to 60 seconds from the original
  floor reservation. It cannot revive an expired reservation or extend a ready/transmitting lease.
- Revalidates the exact authenticated browser connection, authorization, channel membership, selected
  listener, source session, source track, floor state, and lease after every provider wait.
- Force-closes a published or subscribed track if its reservation is no longer current before it can be
  stored or negotiated to a browser.
- Makes PTT media-session writes insert-only, so a delayed concurrent provider response cannot overwrite
  a newer valid media session.

## Safety preserved

All deadlines and extension limits are server-owned. The browser cannot select a lease duration, revive an
expired floor, substitute listeners, retain an old connection after reconnecting, or retain media after
release. Existing role, membership, MFA, audit, cleanup, messaging, scheduling, timekeeping, and payroll
behavior is unchanged. No schema migration, credential, or permission change was required.

## Verification

- PTT lifecycle and socket-bridge coverage passed: **17 tests**.
- Combined PTT UI, controller, media, socket bridge, lifecycle, and Worker coverage passed:
  **6 files / 110 tests**.
- Strict TypeScript, zero-warning lint, `git diff --check`, and the production build passed.

## Production release

The release version and live health/readiness verification are appended after deployment.
