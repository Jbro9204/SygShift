# SygSphere PTT Microphone Setup Recovery — 09/20/2026

## Problem and impact

The first use of channel push-to-talk could show **“Voice setup was interrupted”** even for an authorized
employee. A first-time browser microphone prompt needs an ordinary click, but the old control attempted to
open that prompt while treating the same gesture as press-and-hold voice transmission.

## Root cause

Two client lifecycle paths could cancel microphone capture before it completed:

- A PTT state update re-rendered the chat voice control. Its effect cleanup interpreted that ordinary
  callback refresh as a button release and cancelled capture while the user was still holding it.
- Releasing a control while microphone capture was pending is an expected cancellation, but it was displayed
  as a red failure rather than returning to ready state.

## Repair

- Added a clear, one-time **Set up microphone** action before the hold-to-talk control appears. It requests
  browser access from a normal click, immediately releases the test stream, and never starts, publishes, or
  authorizes a PTT transmission.
- Retained **Hold to talk** only after that setup succeeds, so the control is now a real hold gesture rather
  than a permission prompt.
- Locks the setup action while the browser prompt is open, supports **Escape** to cancel a keyboard-held
  transmission, and clears a previous setup error when a retry succeeds.
- Keeps microphone setup isolated from calls: a late permission result from an older setup attempt cannot
  clear, replace, or show an error over a newer incoming call or account/session change.
- Stabilized the PTT handler lifecycle across normal chat/runtime re-renders so it cannot self-release while
  microphone capture is starting.
- Treats an intentional early release as a silent cancellation. Genuine permission, missing-device, in-use,
  timeout, session, or provider failures still show plain-language recovery guidance.

## Safety preserved

The setup step is client-only and requires the existing authorized PTT capability. It does not contact the
PTT coordinator, create a room, send a floor request, enable a microphone track, publish audio, alter a
role, create a credential, or modify employee, schedule, payroll, or message data. Server authorization,
membership, microphone enablement, leases, audit history, and cleanup remain authoritative.

## Files changed

- `src/components/communications/SygSphereCommunicationsPanel.tsx`
- `src/components/communications/SygSphereCommunicationsRuntime.tsx`
- `src/communications/sygsphereCommunicationsController.ts`
- `src/communications/sygsphereCommunicationsMedia.ts`
- Focused panel, controller, and media regression tests.

No database migration was required.

## Verification

- Focused PTT UI, controller, media, socket bridge, lifecycle, and Worker suite passed: **6 files / 110 tests**.
- `pnpm typecheck` passed.
- `pnpm lint` passed with zero warnings.
- Production build passed.

## Production release

- Released source commit `a04dd85` as SygShift Cloudflare Worker version **466**
  (`9af54b63-7d94-4ff4-b569-6b6a74003230`).
- Both first-party SygShift health and readiness endpoints returned HTTP `200` after release.
- The Communications bootstrap CORS preflight returned HTTP `204` with the exact approved origin,
  credentials enabled, and `Vary: Origin`; an anonymous bootstrap request remained HTTP `401`.
- Rollback point: `rollback/pre-sygsphere-ptt-reliability-completion-20260920`.

## Remaining acceptance

Physical PTT reception still requires two separately authorized employee accounts on two devices. The
production SFU/TURN environment separation remains a separate provider-provisioning task; this client
repair neither creates nor exposes provider credentials.
