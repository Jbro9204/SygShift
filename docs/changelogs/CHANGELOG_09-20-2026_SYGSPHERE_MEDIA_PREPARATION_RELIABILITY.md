# SygSphere Media Preparation Reliability - September 20, 2026

## Outcome

SygSphere no longer gives PTT an unrealistically short window to create TURN credentials, gather browser ICE,
publish audio, and prepare every recipient. One stale or slow authorized device also no longer prevents the
first ready recipient from hearing a transmission.

## Changes

- Increased the protected PTT preparation window from 10 to 30 seconds and refreshed it after the publisher
  finishes provider setup.
- Granted the floor after the first authorized listener completes subscriber negotiation; additional selected
  listeners can finish joining while the renewable transmission is active.
- Increased browser ICE gathering tolerance from 5 to 10 seconds in SygShift and Sygilant.
- Added the exact first-party Worker hostname to the narrow Communications CORS allowlist without adding a
  wildcard or weakening hostile-origin denial.
- Replaced the generic media-preparation failure with actionable timeout, device, permission, and temporary
  service guidance.
- Preserved server-owned permission, membership, microphone, provider, replay, and renewable-floor controls.

## Verification

- SygShift passed strict TypeScript, zero-warning lint, all Communications activation validators, production
  build, and **291 files / 1,491 tests**.
- The desktop/mobile browser matrix passed **102/102** checks: **60** SygSphere checks and the mandatory
  **42** Time Clock preservation checks.
- Sygilant passed lint, all Communications release contracts, Cloudflare package validation, production build,
  and **194 files / 912 tests**.
- Production health and readiness returned HTTP `200` on the custom and Worker origins. All SygSphere routes
  returned HTTP `200`; anonymous Communications bootstrap returned HTTP `401` as required.
- All three exact first-party origins passed Communications preflight. A hostile origin was denied.
- Sygilant production verification passed 13 pages, 28 protected reads, one hostile mutation rejection, and
  80 versioned assets.

## Rollback

- SygShift: `rollback/pre-sygsphere-media-preparation-repair-20260920`
- Sygilant: `rollback/pre-sygsphere-media-preparation-repair-20260920`

No database migration or production-data mutation was required.

## Production Release

- SygShift source: `c223a6a`
- SygShift Worker: `05b5f5ee-2baa-42c4-9e3c-dae51b7169d1`
- Sygilant source: `adba2df`
- Sygilant Pages: `90bd6482-9813-4a09-9805-c5b8e03cad16`

## Remaining Acceptance

Automated media preparation, authorization, release, responsive layout, and recovery verification is complete.
Audible reception still requires two different authorized employee accounts on two devices. That controlled
physical test is the final acceptance step and is not represented as complete by browser simulation.
