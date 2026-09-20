# SygSphere Communications Contract v1

This directory is the SygShift-owned, repository-neutral source of truth for SygSphere Communications protocol artifacts. Sygilant must consume the exact files and digest from this directory rather than maintaining a fork.

## Current revision

- Product-contract revision: `1.0.0-draft.4`
- Wire protocol: `1`
- Artifact SHA-256: `75ae3317cd4f7b5cb737b922dbf27fe2aa6cc80faf9d74e00893f06e8691bbc9`
- Lifecycle: closed coordinator foundation; no production endpoint is enabled

## Compatibility

- Additive optional fields and command/event kinds require a minor or later draft revision.
- Removing, renaming, or changing the meaning of a field requires a new major protocol generation.
- Servers reject unsupported protocol versions with a clear reconnect/update result. They do not partially interpret a command.
- The command envelope never accepts actor, tenant, effective permission, provider session, secret, or unrestricted provider-track authority from a browser.

## Files

- `contract.ts` is the human-readable typed contract source.
- `contract-manifest.json` is the consumer manifest and artifact inventory.
- `command-envelope.schema.json`, `command-payload.schema.json`, `event-envelope.schema.json`, and `event-payload.schema.json` provide strict validation boundaries.
- `integration-gates.ts` and `presentation-policy.ts` are transitive shared policy artifacts and are included in the manifest digest.

Before Sygilant uses a new revision, compare the manifest digest and run its adapter compatibility test against this exact artifact set.

## Negotiation and receive ordering

1. The authorized coordinator sends `media.negotiation` first. Its `peerHandle`, `generation`, `expiresAt`, and every `trackBinding` are server-issued.
2. The browser applies the description and ICE configuration for that exact peer/generation. It may return only the matching `negotiationId`, `peerHandle`, `generation`, and bounded answer; it never chooses a provider session, track, MID, or participant.
3. A remote `ontrack` is usable only when its receiver/transceiver MID equals a `trackBinding.transceiverMid` for that same non-expired generation. The binding supplies the opaque track reference, media kind, publication kind, and—when applicable—the authorized participant connection reference used for local display lookup.
4. Unknown, duplicated, stale, expired, or generation-mismatched tracks are stopped locally and reported as the shared unavailable/reconnecting-safe outcome. A newer generation supersedes every prior mapping.
