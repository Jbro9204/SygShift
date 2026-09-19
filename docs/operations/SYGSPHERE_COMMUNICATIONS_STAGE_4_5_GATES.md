# SygSphere Communications Stage 4/5 Activation Gates

## Current state

The coordinator core and dual-application gate contract are prepared. A source-only SQLite Durable Object binding is declared with a static false runtime flag, but no Worker route, WebSocket, provider adapter, media permission, CSP change, or application-shell runtime is enabled.

Run `pnpm check:sygsphere-comms-stage45` before creating a Stage 4 deployment change. The check protects the current closed state; it is not permission to open any gate.

## Required before enabling Stage 4

1. Apply and validate the reviewed Stage 1/2 coordinator migration through the controlled non-production database path. The Stage B tenant migration is already the authority baseline.
2. Execute the rollback-only SQL regression and record its result.
3. Complete the two-physical-device provider matrix, including forced closure, reconnect, TURN fallback, camera, and screen share.
4. Review the Worker/DO configuration, generated binding types, secret-store binding, rate limits, logs, and rollback procedure.

## Required before enabling Stage 5

1. Stage 4 coordinator receives an approved staging deployment and negative authorization testing.
2. SygShift and Sygilant both verify the shared contract revision and the same closed-by-default activation gate.
3. The persistent shell passes route-remount, draft-preservation, accessibility, mobile, and fallback-message testing.

## Safety behavior

Until every authoritative gate is true, both applications must keep communications unmounted and direct employees to SygSphere messages and Dispatch. A browser cannot provide or override gate state, tenant identity, employee identity, or permissions.
