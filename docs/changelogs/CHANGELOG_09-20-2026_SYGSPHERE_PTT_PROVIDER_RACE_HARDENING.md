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

- Released source commit `a04dd85` as SygShift Cloudflare Worker version **466**
  (`9af54b63-7d94-4ff4-b569-6b6a74003230`).
- Both first-party SygShift health and readiness endpoints returned HTTP `200` after release.
- The Communications bootstrap CORS preflight returned HTTP `204` with the exact approved origin,
  credentials enabled, and `Vary: Origin`; an anonymous bootstrap request remained HTTP `401`.
- Rollback point: `rollback/pre-sygsphere-ptt-reliability-completion-20260920`.

## Remaining acceptance

Physical PTT reception still requires two separately authorized employee accounts on two devices. This
release confirms the application and coordinator lifecycle; it does not substitute for testing the actual
microphone, speaker, browser permission, and network conditions of those devices.
