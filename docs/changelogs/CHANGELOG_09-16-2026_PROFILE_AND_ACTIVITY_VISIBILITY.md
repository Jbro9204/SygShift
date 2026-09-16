# 09/16/2026 - Profile and Activity Visibility

## Outcome

Profile identities and activity states are now easier to recognize throughout SygSphere and User Accounts without changing how presence is calculated or used.

## Changes

- Increased standard SygSphere identity avatars to 44 pixels, message avatars to 40 pixels on larger screens, and message avatars to 36 pixels on phones.
- Increased avatar activity indicators to 14 pixels and inline member indicators to 11 pixels.
- Enlarged read-receipt identities while keeping the reader name and exact read time visible in the existing accessible panel.
- Increased User Accounts presence indicators to 12 pixels.
- Strengthened Active, Away, and Offline contrast, with a panel-colored separation ring so the indicator remains distinct over both photos and initials.
- Made Never active a hollow indicator so it is distinguishable by shape as well as color.
- Preserved the written status labels throughout the interface; color is not the only status signal.
- Kept the enlarged indicator outside the photo edge without clipping and retained compact mobile spacing.

## Safety and scope

- No presence timing, heartbeat, database, authorization, MFA, attendance, payroll, timekeeping, or notification behavior changed.
- No migration or production-data mutation was required.
- Existing rounded controls, typography, responsive behavior, and SygSphere workflows were preserved.

## Verification

- `pnpm check` passed: 264 test files and 1,336 tests, strict TypeScript, zero-warning lint, and production build.
- 102 desktop/mobile Playwright checks passed across SygSphere, User Accounts, and the actual Time Clock component.
- The rendered geometry regression verified 44-pixel identity avatars, 14-pixel photo indicators, 36-pixel mobile message avatars, visible contrast borders, no indicator clipping, and no account-table overflow.
- Companion Sygilant quality verification passed every source, database, security, identity, Worker, readability, legibility, and UI contract plus 179 test files and 831 tests.

## Release

- Deployment evidence will be added after the production postflight completes.
