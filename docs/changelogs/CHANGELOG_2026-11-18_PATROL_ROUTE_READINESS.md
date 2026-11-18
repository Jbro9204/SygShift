# Patrol route readiness guidance — 11/18/2026

Status: local repair; not deployed. No database migration or production record change.

## Scope and changes

- Route cards and the selected route in Operations now identify missing property, client, post or weekday requirement links before opening the editor. An Active label is not presented as proof of complete setup.
- The exact selected employee/shift shows when no patrol route is connected. The guidance distinguishes a published schedule assignment from a patrol route assignment and calls out the need to check the current published revision.
- Reuses existing bounded workspace data, permission checks, validation, controls and styles. Assignment-only managers are not shown false property errors from a deliberately restricted location catalog.
- No route inference, automatic mapping, new RPC, changed save/connection contract, new permissions or schedule mutation.

## Verification

- Focused: 40 tests passed across PatrolPage, patrol field readiness, patrol operations, and patrol data suites.
- Browser layout: 12 cases passed on 390px/1440px light/dark views, including eight read-only readiness cases and the four existing isolated route-save cases. External requests were blocked; readiness cases performed no mutations. Four representative screenshots were visually inspected without clipping or horizontal overflow.
- Application suite: 2,650 tests passed across 412 files; one existing private-corpus case skipped. Mandatory Time Clock: 42/42 desktop/mobile cases passed on the controlled loopback fixture, without real employee punches.
- Full pnpm check passed: toolchain validation, TypeScript, lint, application suite, history/route native PostgreSQL checks, release-tool regressions and production Worker/client builds/static assets. The native route suite passed 66 checks and history suite 47; release-tool tests retain four existing platform-specific skips. A fresh production build completed after the final Time Clock browser run. The machine's bundled pnpm launcher printed a Node-engine warning on nested invocations; actual repository toolchain validation passed. The stale private pinned launcher path was corrected without editing project configuration.
- Read-only production health checks returned HTTP 200 for both applications and SygShift readiness was true. These are health observations, not a live route-acceptance test.
- No live employee acceptance or deployment is claimed.

## Remaining work and rollback

Operations must confirm real property records and connect complete routes to exact current published shifts and employees. No live MG mappings were changed.

Read-only lifecycle review found that schedule revision cloning creates new shift identifiers without transferring native patrol assignments/obligations. This change makes the current-link requirement explicit; it does not repair automatic lifecycle transfer. A separate transactional repair needs exact lineage and rules for started/completed work, changed times, employee removals/reassignment, retained versions and duplicate obligations. No guessed carry-forward is authorized by this patch.

Rollback is the application/test changes and isolated browser-fixture additions; no database or production rollback is needed for this local-only change.
