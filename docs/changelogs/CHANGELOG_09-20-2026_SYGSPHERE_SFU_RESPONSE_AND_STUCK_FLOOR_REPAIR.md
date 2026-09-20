# SygSphere SFU Response and Stuck-Floor Repair - September 20, 2026

## Incident

Production PTT and meeting attempts could show **Voice service is temporarily unavailable**, expire while
preparing, or leave the channel reporting that another employee was speaking. A meeting could also display
**Voice call connected** while provider negotiation was still incomplete.

## Root cause

Cloudflare Realtime accepts and documents successful track responses without repeating each requested track's
`location`. The shared adapter treated that optional omission as a provider rejection, so valid SFU publish
and subscribe answers were returned to the browser as `provider_unavailable`. The browser and Worker also
needed a larger margin around Cloudflare's documented connection wait, and media-failure cleanup did not
always release a server-reserved PTT floor.

## Repair

- Accept documented SFU track responses that omit `location`, while still rejecting an explicit mismatched
  location and normalizing accepted tracks to the request direction.
- Increased the provider request boundary to 15 seconds and browser media operations to 20 seconds so a
  valid provider operation is not cancelled at the same five-second boundary the provider may consume.
- Cancel or release the authoritative PTT floor and close failed call/meeting media whenever local media
  preparation fails.
- Reap expired floors before protected PTT operations, close partial provider tracks, guard delayed provider
  results with renewable lease generations, and release reservations after disconnect or provider failure.
- Keep calls and meetings in **Securing voice connection** until the matching local audio publication has a
  successfully applied provider answer. A membership or focus grant alone no longer claims audio is connected.
- Treat an SDP answer as negotiation progress, not a connected call. PTT, direct calls, and meetings now wait
  for the browser peer connection to report `connected`, expose bounded reconnecting/failed states, and close
  incomplete media when that deadline expires.
- Keep the PTT button in **Checking channel** while the pointer is held but the authoritative floor or listener
  transport is not ready. A denial, expiry, provider failure, or reconnect failure clears the held state and
  releases the floor instead of leaving **Talking now** or **Someone else is speaking** behind.
- Ignore delayed camera and screen-share events from an older call so a stale media event cannot alter the
  current conversation.
- Preserve all existing role, channel-membership, MFA, audit, messaging, scheduling, timekeeping, and payroll
  boundaries. No database migration, permission expansion, credential change, or production-data rewrite is
  required.

## Verification

- Full SygShift gate passed: strict TypeScript, zero-warning lint, **291 test files / 1,519 tests**, and both
  production builds.
- Communications Stage 5/6 and Stage 6/7 activation gates passed.
- Paired Sygilant gate passed: source and database contracts, UI/readability checks, lint, strict TypeScript,
  **198 test files / 945 tests**, Cloudflare package validation, and production build.
- The complete SygShift desktop/mobile browser matrix passed **348 checks** with **12 intentional project
  skips**, including SygSphere and the mandatory real Time Clock workflow preservation suite.
- After lifecycle hardening, the focused desktop/mobile SygSphere plus mandatory Time Clock matrix passed all
  **102 checks** against the final build.
- Physical microphone-to-speaker acceptance still requires two separately authenticated employee accounts on
  two devices. Automated tests do not claim that audible ceremony occurred.

## Production release

- SygShift source: `f2ab608`; Cloudflare Worker: `71fd9f73-631c-4012-9c6d-a4aece5b79f0`.
- Sygilant source: `a560455`; Cloudflare Pages: `3418c578-ed19-4f85-a8b2-10ad82c9d93b`.
- `app.sygilant.us`, the Worker origin, `sygilant.us`, and the immutable Pages deployment passed health and
  readiness. Both SygSphere routes returned HTTP 200 and each live entry page referenced the exact final
  production assets.
- The anonymous Communications bootstrap remained HTTP 401. The approved Sygilant-origin preflight returned
  HTTP 204 with exact-origin credentials and `Vary: Origin`; a hostile origin received no CORS grant.
- Sygilant's production verifier passed 13 pages, 28 protected reads, one hostile mutation denial, and 80
  versioned assets.
- Rollback points: `rollback/pre-sygsphere-sfu-response-repair-20260920` and
  `rollback/pre-sygilant-sfu-response-repair-20260920`.
- Superseding lifecycle code: SygShift `c2c42ca` and Sygilant `3eef2c1`.
- Final SygShift Worker: `8fb7a981-7237-4d23-a1d4-6cc5198e6e26`; accepted Sygilant Pages deployment:
  `a1c18caf-a8a8-4daa-87d2-99a4443c15dc`.
- Final postflight returned HTTP 200 for both applications, both SygSphere routes, health, and readiness;
  anonymous bootstrap remained HTTP 401; approved-origin CORS returned exact-origin credentials; hostile
  origin received no grant; and live entry assets matched the final local builds byte-for-byte.

## Follow-up

Speaker selection and in-app output-volume controls remain queued behind successful transport acceptance.
They are not represented as a fix for the provider failure.
