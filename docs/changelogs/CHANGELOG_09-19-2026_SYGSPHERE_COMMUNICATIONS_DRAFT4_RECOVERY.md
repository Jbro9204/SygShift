# SygSphere Communications — Draft 4 Recovery and Media Contract

**Date:** September 19, 2026  
**Status:** Source-controlled foundation prepared. Runtime, provider, role, and pilot gates remain closed.

## Added

- `1.0.0-draft.4` with strict server-to-browser payload schemas for every event kind.
- A complete media-negotiation shape: opaque server peer handle; direction; generation; expiry; bounded session description and ICE configuration; and typed, server-issued track bindings.
- Remote-track matching rules: a browser may render a remote track only when its receiver MID matches the current negotiation’s authorized binding. The browser cannot choose a provider session, track, MID, peer, participant, or permission.
- Generation-fenced media answer, readiness, and stop commands. A stale or unmatched negotiation cannot be completed by the browser.
- A correlated `floor.renewed` event with the authoritative lease expiry and generation. A client must stop PTT if acknowledgement is missing or expires.
- Closed, provider-neutral media negotiation, session/track teardown, room recovery/replay, lease-bound outbox, and verified usage-reconciliation modules.
- An additive, unapplied private-data migration for append-only room events, delivery outbox records, and digest-addressed usage evidence. All relations use forced RLS and revoke browser/database-role access.

## Safety controls retained

- No Cloudflare credential, provider endpoint, SDP, ICE credential, browser media API, CSP change, worker runtime, provider registry, role grant, pilot cohort, call, meeting, PTT, camera, or screen sharing capability was enabled.
- Empty or unverified telemetry remains unavailable; it is never reported as zero or reconciled usage.
- Coordinator restart/replay rejects gaps, mismatched room identity, duplicated event IDs, stale lease completion, and browser-shaped authority data.
- Existing SygShift scheduling, time, HR, documents, messaging, and Dispatch paths remain outside this closed feature boundary.

## Cross-application handoff

Sygilant must consume exactly `1.0.0-draft.4` with artifact digest `75ae3317cd4f7b5cb737b922dbf27fe2aa6cc80faf9d74e00893f06e8691bbc9`. Draft 3 remains a historical artifact; it must not be mixed with Draft 4 media events or commands.

## Remaining release evidence

The code does not substitute for the required physical two-device Cloudflare validation, staged provider credential controls, real TURN fallback test, device/browser/network matrix, accessibility verification, pilot evidence, or explicit release authorization. The pilot record remains Not run until that evidence exists.
