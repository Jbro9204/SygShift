# SygSphere Communications Contract v1

This directory is the SygShift-owned, repository-neutral source of truth for SygSphere Communications protocol artifacts. Sygilant must consume the exact files and digest from this directory rather than maintaining a fork.

## Current revision

- Product-contract revision: `1.0.0-draft.2`
- Wire protocol: `1`
- Artifact SHA-256: `3ef56737b0aaa5710a1ac337a2d549a6bcfceaaa1b884c03337a84b0fb149d75`
- Lifecycle: closed coordinator foundation; no production endpoint is enabled

## Compatibility

- Additive optional fields and command/event kinds require a minor or later draft revision.
- Removing, renaming, or changing the meaning of a field requires a new major protocol generation.
- Servers reject unsupported protocol versions with a clear reconnect/update result. They do not partially interpret a command.
- The command envelope never accepts actor, tenant, effective permission, provider session, secret, or unrestricted provider-track authority from a browser.

## Files

- `contract.ts` is the human-readable typed contract source.
- `contract-manifest.json` is the consumer manifest and artifact inventory.
- `command-envelope.schema.json`, `command-payload.schema.json`, and `event-envelope.schema.json` provide strict validation boundaries.
- `integration-gates.ts` and `presentation-policy.ts` are transitive shared policy artifacts and are included in the manifest digest.

Before Sygilant uses a new revision, compare the manifest digest and run its adapter compatibility test against this exact artifact set.
