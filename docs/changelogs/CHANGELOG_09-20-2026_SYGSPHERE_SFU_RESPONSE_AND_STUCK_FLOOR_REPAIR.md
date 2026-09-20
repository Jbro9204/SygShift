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
- Preserve all existing role, channel-membership, MFA, audit, messaging, scheduling, timekeeping, and payroll
  boundaries. No database migration, permission expansion, credential change, or production-data rewrite is
  required.

## Verification

- Full SygShift gate passed: strict TypeScript, zero-warning lint, **291 test files / 1,509 tests**, and both
  production builds.
- Communications Stage 5/6 and Stage 6/7 activation gates passed.
- Paired Sygilant gate passed: source and database contracts, UI/readability checks, lint, strict TypeScript,
  **196 test files / 926 tests**, Cloudflare package validation, and production build.
- Physical microphone-to-speaker acceptance still requires two separately authenticated employee accounts on
  two devices. Automated tests do not claim that audible ceremony occurred.

## Production release

Production identifiers and postflight evidence will be added after both coordinated deployments complete.

## Follow-up

Speaker selection and in-app output-volume controls remain queued behind successful transport acceptance.
They are not represented as a fix for the provider failure.
