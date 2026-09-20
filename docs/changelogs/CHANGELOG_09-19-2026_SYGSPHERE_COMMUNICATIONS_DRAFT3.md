# SygSphere Communications — Draft 3 Shared Contract

**Date:** September 19, 2026  
**Status:** Shared source contract prepared. Runtime, provider, role, and pilot gates remain closed.

## Added

- Explicit, bounded commands for direct-call requests; meeting create/join/leave/end; participant removal/muting; and camera request/release.
- Matching server events for requested calls, meeting lifecycle, moderation, and camera state.
- Server permission mapping for every new command. Call requests require the call-start permission; meeting creation requires meeting-create; moderation requires moderate; camera publication requires video-publish.
- An additive database migration which accepts the draft-3 command set while preserving draft-2 compatibility until both applications record the matching revision.
- A shared usage response model with a 1,000 decimal-GB allowance, $0.05/GB projected overage, a UTC billing period, remaining allowance, reconciliation timestamp, and truthful `unavailable`, `estimated`, or `reconciled` status.

## Safety controls retained

- Requests use opaque conversation, meeting, and server-issued connection references—not browser-selected employee, tenant, permission, scope, room-membership, or provider authority.
- The service authorization function continues to fail closed until an approved assignment/room policy is implemented.
- No Worker runtime, provider adapter, Cloudflare secret, role grant, microphone/camera/screen request, call, meeting, or employee-facing UI was enabled.

## Verification

- Typecheck and warning-free lint passed.
- Draft-3 contract, migration-permission, and usage tests passed.
- The existing closed coordinator/ingress gate validator passed.

## Cross-application handoff

Sygilant must consume **exactly** `1.0.0-draft.3` with artifact digest `770202cde701818d64b24e3751c7292c6963c8a7209e3555095f602bfd137e1f` before a compatibility gate can be recorded true.
