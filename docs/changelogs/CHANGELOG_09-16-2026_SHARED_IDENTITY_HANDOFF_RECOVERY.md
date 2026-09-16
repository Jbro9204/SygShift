# Shared Identity Handoff Recovery — September 16, 2026

## Outcome

The Sygilant button now begins shared access only from the official SygShift application. If someone opens a stale Worker or preview address, SygShift returns them to the official workspace before any handoff assertion is created. This prevents the raw `shared_identity_origin_denied` failure shown in the reported incident without broadening the trusted-origin boundary.

## SygShift changes

- Added one exact official-origin check for the Sygilant launcher: `https://app.sygilant.us`.
- Stopped noncanonical Worker, preview, local, or copied-host pages from requesting a shared-identity assertion.
- Added a plain-language, accessible recovery message and immediate return to the official SygShift address.
- Kept the existing button destination, signed assertion, one-time exchange, employee mapping, permissions, MFA, and direct SygShift login behavior unchanged.

## Security and preservation

- No wildcard origin, Worker-domain allowlist, token exposure, credential copy, or browser storage fallback was added.
- Sygilant continues to validate the signed, short-lived, one-time assertion and independently introspect it with SygShift.
- No database migration or production-data mutation was required.
- Employee data, roles, permissions, MFA factors, remembered devices, schedules, punches, payroll, HR records, documents, and audit history were not changed.

## Verification before release

- Focused SygShift launcher tests passed: **2 files / 11 tests**.
- The complete SygShift gate passed: **260 files / 1,327 tests**, TypeScript, zero-warning lint, Worker build, and client production build.
- The required actual-component Time Clock preservation matrix passed **42/42** across desktop and mobile.
- A fresh production build passed after the browser test run.
- The companion Sygilant receiver passed **23 focused tests** and the complete **175-file / 824-test** quality gate.

## Release status

- Production deployment and live postflight evidence will be appended after the exact source commits are activated.

## Files

- `src/components/SygilantLauncher.tsx`
- `src/components/SygilantLauncher.test.tsx`
- `src/data/platformLaunch.ts`
- `src/data/platformLaunch.test.ts`
