# SygShift Changelog - 09/18/2026

## Remembered-Device Continuity Repair

### Problem and impact

A browser can retain the same 14-day remembered-device proof in both local storage and a parent-domain cookie.
If those copies diverged after a reconnect, browser restore, or prior release, SygShift always preferred the local
copy and never sent the cookie copy. A stale local value could therefore hide a still-valid server-issued proof,
forcing another MFA challenge and degrading SygShift-to-Sygilant switching for every MFA-required role.

### Resolution

- Deduplicated both existing browser proofs and sent the cookie value as a bounded fallback only when it differs.
- Forwarded the fallback through protected Worker calls and Sygilant launch session revalidation.
- Added a forward-only database migration that accepts either proof only when its SHA-256 hash belongs to the
  current active employee, is unrevoked, and remains inside its original expiration window.
- Aligned the browser cookie lifetime with the existing 14-day database and user-interface policy.
- Preserved role permissions, the Guard MFA exception, account-state checks, token length limits, revocation,
  database hashing, and every existing AAL2, security-key, and shared-identity assurance path.

### Verification

- Focused remembered-device and Sygilant launch suite: **2 files / 45 tests passed**.
- Complete release gate: **267 files / 1,352 tests passed**, plus strict TypeScript, zero-warning lint, Worker
  build, and client production build.
- Full Playwright browser suite: **346 passed / 12 intentionally skipped / 0 failed** across desktop and mobile.
- Required actual-component Time Clock workflow passed on desktop and mobile, including clock in, break, clock
  out, same-shift return, duplicate submission prevention, role coverage, and failure recovery.
- `git diff --check`: passed.

### Database and security

- Forward-only migration: `20260918152903_trusted_device_store_divergence_fallback.sql`.
- No plaintext device proof is stored or logged. Existing server-side hashes and revocation records remain the
  authority.
- The fallback is not a new credential and cannot extend the original 14-day expiration.
- Employee, role, permission, schedule, timekeeping, payroll, and SygSphere records are unchanged.

### Release status

- Pre-change rollback tag: `rollback/pre-trusted-device-continuity-20260918` at source `ad123cf`.
- Source revision: `540c048` (`fix: preserve remembered-device continuity`).
- Production migration `20260918152903` was applied through an isolated release workspace. A post-deployment
  migration dry run confirmed that the shared production database is fully up to date with no pending changes.
- Cloudflare Worker version: `501dd9da-5ead-426a-ba22-565c8aa1e1c4`.
- Public and fallback `/api/v1/health` and `/api/v1/ready` checks returned HTTP 200; readiness reported every
  required binding and shared-identity secret available.
- Live browser verification passed from SygShift to Sygilant and back to SygShift without another credential or
  MFA prompt.
- Zach's browser must complete one post-release sign-in and remembered-device selection to replace any already
  stale local proof. Persistence across his next-day browser restart remains the final user-specific canary.
