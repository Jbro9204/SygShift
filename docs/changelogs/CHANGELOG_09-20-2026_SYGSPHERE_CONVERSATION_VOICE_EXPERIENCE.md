# SygSphere Conversation Voice Experience - September 20, 2026

## Outcome

SygSphere is conversation-first again. Text chat remains the primary workspace, while voice is a compact
secondary control inside the selected conversation in both SygShift and Sygilant.

## Changes

- Removed the oversized standalone communications dashboard from above the message workspace.
- Added a compact voice bar directly below the selected conversation header.
- Bound PTT to the open authorized channel, direct calls to the open one-to-one conversation, and meetings to
  the open channel or group conversation.
- Kept the message history and composer visible at desktop, short-laptop, and phone sizes.
- Moved incoming audio playback to the authenticated application shell so authorized PTT and call audio can be
  heard even when the recipient is working outside the SygSphere page.
- Added a clear one-tap recovery when browser autoplay policy pauses incoming audio.
- Replaced raw communications state codes with plain operational guidance.
- Preserved the existing server-authoritative permission, membership, microphone, camera, screen-share,
  meeting, call, and PTT boundaries.

## Verification

- SygShift full release gate: **291 files / 1,489 tests**, strict TypeScript, zero-warning lint, and production
  build passed.
- Focused SygShift communications coverage: **52 tests** passed.
- SygShift SygSphere responsive browser matrix: **60/60** passed across desktop and mobile, including a 320px
  phone and short-laptop viewport.
- Mandatory Time Clock preservation matrix: **42/42** passed across desktop and mobile.
- Sygilant focused conversation, runtime, and page coverage: **12/12** passed.
- Sygilant full suite previously passed **194 files / 912 tests**; final lint, production build, UI contract,
  communications release gate, and shared communications contract passed.
- `git diff --check` passed in both repositories.

## Rollback

- SygShift: `rollback/pre-sygsphere-conversation-voice-repair-20260920`
- Sygilant: `rollback/pre-sygsphere-conversation-voice-repair-20260920`

## Production Release

- SygShift source: `ab6a596`
- SygShift Worker: `44579962-45c2-4b6a-bd4b-d67c0ad9513d`
- Sygilant source: `f0c7eed`
- Sygilant Pages: `105f574b-ae06-4f10-ae5d-78395909a41f`
- SygShift health and readiness returned HTTP `200`; both production SygSphere routes and the immutable Pages
  deployment returned HTTP `200`.
- Sygilant production verification passed 13 pages, 28 protected reads, one hostile mutation rejection, and
  80 versioned assets.
- Anonymous communications bootstrap returned HTTP `401` as required.
- Authenticated live inspection confirmed Ready state, the compact channel PTT bar in SygShift, the compact
  private Call bar in Sygilant, readable light/dark presentation, visible message history, and a reachable
  composer.

## Remaining Acceptance

Automated transport, rendering, authorization, and recovery coverage is complete. Physical audible reception,
camera, and screen-share acceptance still requires two different authorized employee accounts on two devices;
the same employee in two tabs is intentionally not a valid listener test.
