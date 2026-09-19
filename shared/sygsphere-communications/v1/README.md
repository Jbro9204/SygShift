# SygSphere Communications Contract v1

This directory is the SygShift-owned, repository-neutral source of truth for SygSphere Communications protocol artifacts. Sygilant must consume the exact files and digest from this directory rather than maintaining a fork.

## Current revision

- Product-contract revision: `1.0.0-draft.1`
- Wire protocol: `1`
- Artifact SHA-256: `a93294b1dcf07eb7fdbdf70c1d687856286ebe392baa6e9afd7d1a53f7dcbd16`
- Lifecycle: discovery/spike checkpoint only; no production endpoint is enabled

## Compatibility

- Additive optional fields and command/event kinds require a minor or later draft revision.
- Removing, renaming, or changing the meaning of a field requires a new major protocol generation.
- Servers reject unsupported protocol versions with a clear reconnect/update result. They do not partially interpret a command.
- The command envelope never accepts actor, tenant, effective permission, provider session, secret, or unrestricted provider-track authority from a browser.

## Files

- `contract.ts` is the human-readable typed contract source.
- `contract-manifest.json` is the consumer manifest and artifact inventory.
- `command-envelope.schema.json` and `event-envelope.schema.json` provide strict envelope validation boundaries.

Before Sygilant uses a new revision, compare the manifest digest and run its adapter compatibility test against this exact artifact set.
