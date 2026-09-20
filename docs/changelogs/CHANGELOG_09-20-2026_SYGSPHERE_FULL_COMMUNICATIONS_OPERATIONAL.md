# SygSphere full communications operational release — September 20, 2026

## Outcome

The shared SygSphere communications system is live in both SygShift and Sygilant. It provides permission-controlled channel push-to-talk, direct voice calling, meetings, video, and user-initiated screen sharing through one shared backend and one versioned contract.

## What is live

- **Push-to-talk:** a channel member can request the floor only when they have the PTT permission. The server derives channel membership and listeners; a browser cannot supply its own recipients.
- **PTT safety:** microphone publishing stays muted until every required active listener is ready. Floor leases expire after six seconds unless renewed, and release, cancellation, disconnection, or expiry closes the media session.
- **Direct voice calls:** ring, accept, decline, timeout, missed-call history, reconnect handling, mute, and device controls.
- **Meetings:** participant roster, moderation, participant mute/remove, reconnect recovery, video, and user-initiated screen sharing.
- **Shared identity and authorization:** SygShift remains the authority for active employee identity, permissions, and membership; Sygilant consumes the same protected runtime instead of maintaining a competing communications backend.
- **User experience:** incoming-call, permission, ready, ringing, connecting, active, reconnecting, denied, unavailable, failed, and ended states are deliberately handled without exposing provider errors.

The currently available shared PTT scope is a SygSphere channel. Site, shift, assignment, and dispatch scope are represented in the protocol for future data-backed routing, but no unsourced schedule relationship is inferred by the application.

## Production changes

| Item | Verified value |
| --- | --- |
| SygShift source | `3707a420734aff20461e0bb6d15d6873da6271cf` |
| Sygilant source | `c4369f9e9c0ffd8709a09e215acb9e71707b2537` |
| Shared contract | `1.0.0-draft.6` |
| Shared contract digest | `b56f9eb1e5684c0de332d973dd8b65e43530ea7be2c295fb83399612e68f6e76` |
| SygShift Worker | `6bb2c9de-3058-4663-8a84-4bffc6223bfe` |
| Sygilant Pages deployment | `cdc8edb1-e6a1-478f-825a-13961033517c` |
| Database migration | `20260920034500_sygsphere_communications_ptt_channel_scope.sql` |

The database release gate reports draft.6 with database foundation, command schemas, provider evidence, coordinator approval, compatibility verification, and runtime enablement all true. Communications resolver functions are service-only; authenticated browsers cannot invoke those database functions directly.

## Release verification

- SygShift typecheck, lint, tests, and production build passed: **291 test files / 1,482 tests**.
- The real SygShift timekeeping end-to-end suite passed: **42 of 42** desktop and mobile scenarios.
- Sygilant contract gate, lint, tests, Cloudflare build, and production build passed: **192 test files / 905 tests**.
- Production checks returned success from `app.sygilant.us` health and readiness endpoints, SygShift's SygSphere route, Sygilant's site, Sygilant's SygSphere route, Sygilant's health endpoint, and the immutable Pages deployment URL.
- An unauthenticated request to the communications bootstrap endpoint was rejected with HTTP 401.

## Rollback points

- SygShift: `rollback/sygsphere-full-comms-pre-20260920` (`f4b962f`)
- Sygilant: `rollback/sygilant-shared-comms-pre-20260920` (`3abd9eb`)

## Operational acceptance

The application, database contract, and Cloudflare deployments are operational. A two-person device acceptance check remains appropriate for the owner or test users: join the same authorized channel on two real devices, grant microphone permission, hold PTT, release it, place a direct call, and confirm the expected device audio/video behavior. This verifies the physical microphone, camera, and network conditions of the actual devices without weakening authorization or changing live data.
