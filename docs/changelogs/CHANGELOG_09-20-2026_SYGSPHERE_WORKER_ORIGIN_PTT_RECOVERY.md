# SygSphere Worker-Origin PTT Recovery — 09/20/2026

## Problem and impact

Some authorized employees opening SygShift from its official Worker launch address received the generic
**“Communications could not be prepared”** message when using push-to-talk. The same protected
Communications runtime was available from the custom Sygilant address, making the failure confusing and
preventing otherwise-authorized PTT use on that first-party launch path.

## Root cause

The Communications WebSocket uses an intentionally narrow origin allow-list. It included the approved
custom Sygilant origins but omitted SygShift's official Worker hostname. The Worker therefore rejected the
WebSocket upgrade before PTT could prepare its media session. Slow negotiation could also exhaust the
former five-second ICE/preparation window, and a PTT floor waited for every selected listener before it
could begin.

## Repair

- Added only `https://sygshift.sygilant.workers.dev` to the existing exact Communications origin allow-list.
  No wildcard, third-party origin, role, channel, or media permission was added.
- Added a regression test for the first-party Worker-origin CORS boundary.
- Hardened media preparation for real network conditions: the ICE window is now ten seconds, the server
  preparation lease is renewable for thirty seconds while the publisher is negotiating, and a PTT floor can
  start once one authorized listener is ready while other authorized listeners finish joining.
- Kept the server as the authority for authorization, audience membership, floor ownership, microphone
  enablement, lease expiry, and cleanup.
- Replaced the opaque generic failure with specific plain-language guidance where the browser exposes a
  microphone, permission, timeout, session, rate-limit, or recipient-availability cause.

## Files changed

- `worker/index.ts`
- `worker/comms/pttLifecycle.ts`
- `worker/comms/tenantCommsDurableObject.ts`
- `src/communications/sygsphereCommunicationsController.ts`
- `src/communications/sygsphereCommunicationsPeerTransport.ts`
- `src/communications/sygsphereCommunicationsSocketBridge.ts`
- Focused controller, PTT lifecycle, socket bridge, and Worker boundary regression tests.

No database migration or employee, schedule, payroll, message, or account-record mutation was required.

## Verification

- `pnpm typecheck` passed.
- `pnpm lint` passed with zero warnings.
- Focused Worker, controller, socket bridge, and PTT lifecycle suite passed: **4 files / 80 tests**.
- `pnpm build` passed.
- `git diff --check` passed before release preparation.

## Git and deployment status

- Source repair commit: `c223a6a` (`fix: harden SygSphere media preparation`).
- Release record commit: `d6830f4`; pushed to `origin/main`.
- Cloudflare Worker deployed as version **463** (`e5232327-7048-4207-a14a-58a167059b6c`) at 100% traffic.
- Both the custom application host and the official Worker host returned health HTTP `200`; readiness returned
  HTTP `200` with all configured checks ready.
- The official Worker-origin Communications preflight now returns HTTP `204`, its exact
  `Access-Control-Allow-Origin` value, credentials enabled, and `Vary: Origin`.
- An anonymous Communications bootstrap still returns HTTP `401`; the repair did not make PTT public.

## Remaining acceptance

The first-party Worker-origin failure is repaired in source and covered by a regression test. Physical
end-to-end PTT reception still requires two separately authorized employee accounts on two devices with
microphones; a single employee using two tabs is not an acceptable listener test.
