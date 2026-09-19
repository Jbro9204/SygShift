# SygSphere Communications Stage A — Staging Provider Evidence

## Boundary

This gate validates an isolated Cloudflare Realtime SFU/TURN staging application only. It must not reuse production credentials, route production calls, change production flags, or publish a media-capable Worker.

## Required evidence before completion

1. A separate staging Realtime application and a least-privilege API token are present in the secret store; no credential value is recorded in this repository.
2. Account Analytics is checked for the staging application capability and retention/export requirements.
3. Two physical devices on distinct networks complete real audio, forced sender closure, forced receiver closure, idle reconnect, track reuse prevention, TURN UDP/TCP/TLS, camera, and screen-share checks.
4. Each result is recorded as pass/fail with UTC timestamp, app identifier (not a secret), browser/device class, and a redacted request/correlation identifier.
5. The isolated staging resource can be disabled or deleted without changing SygShift production state.

## Current result

- Isolated staging SFU application: `sygsphere-communications-staging` (`643a90a9acbeacb7b85d3da18ddf1bb7`).
- Staging TURN key identifier: `f800b6bc2cb66e5a406f62496758abdb`.
- The fail-closed preflight was executed through the protected staging secret store and returned `turn-credential-validated` with two ICE server entries. Credential material was not retained here.
- A temporary local-only server-side-secret SFU probe submitted a synthetic video offer; Cloudflare returned HTTP `201` and the browser established a WebRTC transport. The probe was removed immediately afterward and no secret entered source or browser code.
- SFU and TURN Account Analytics dashboards are accessible. Recent usage is currently empty, which is expected before the physical-device exercise and normal analytics ingestion delay.
- Account Analytics capability check and the two-device media matrix are still **not executed**. No audio, forced closure, reconnect, track reuse, TLS TURN, camera, screen-share, or revocation behavior is claimed validated.
