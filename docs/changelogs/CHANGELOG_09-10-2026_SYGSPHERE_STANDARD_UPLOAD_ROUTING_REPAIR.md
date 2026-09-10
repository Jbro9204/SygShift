# SygSphere Standard Upload Routing Repair

Date: 09/10/2026

## Outcome

SygSphere now transfers normal documents and photos through Supabase's signed standard-upload method before starting the existing private security check. This corrects the desktop and mobile failure where a small attachment produced an authorized upload record but never created the corresponding private storage object.

## Root cause corrected

- Production evidence for the reported desktop PDF showed an upload record remaining in `prepared` state with no failure stage, no recorded attempt, and no matching object in the private `sygsphere-files` bucket.
- The earlier completion repair correctly handled the separate case where a finished transfer was briefly unavailable to the Worker, but it could not recover a transfer that never reached storage.
- The client had routed every attachment through TUS resumable upload, including very small PDFs and photos. The affected browsers reported resumable success without persisting an object, so finalization correctly failed closed.

## Application changes

- Added one centralized 6 MiB transfer boundary in the SygSphere upload client.
- Files through 6 MiB now use the existing Worker-authorized signed storage token with `uploadToSignedUrl`.
- Files over 6 MiB continue to use the existing signed TUS resumable path and 6 MiB chunks.
- Both transfer methods still enter the same private `sygsphere-files` quarantine, Worker finalization, byte/type validation, asynchronous malware scan, audit trail, participant authorization, and clean-file publication process.
- Preserved the selected attachment and draft on a standard-transfer failure and now reports that the failure occurred before storage received the file.
- Added unit and real-component browser regressions that prove a normal desktop PDF reaches its signed storage target before the Worker completion request is sent.

## Preservation boundary

- No database migration was added or applied.
- No storage policy, row-level security policy, permission, role, MFA, conversation membership, message, notification, timekeeping, schedule, payroll, HR, or employee record changed.
- Files remain unavailable to conversation participants until the existing scanner marks them clean.
- Existing limits remain unchanged: supported documents and ordinary files through 25 MB, supported JPEG/PNG/WebP images through 100 MB.
- Larger attachments retain resumable transfer; this repair does not weaken or bypass upload authorization or scanning.

## Verification

- Focused SygSphere unit and architecture tests: 16/16 passed.
- `pnpm check`: passed TypeScript, zero-warning application lint, 229 test files, 1,184 tests, Worker build, and client production build.
- Combined SygSphere and mandatory actual-component Time Clock browser matrix: 88/88 desktop/mobile checks passed.
- The browser regression transfers a desktop PDF through the signed standard storage method and verifies that Worker completion occurs only afterward.
- Required fresh production build after browser testing passed immediately before deployment.
- Post-deployment mandatory Time Clock workflow: 42/42 desktop/mobile checks passed.
- Primary and fallback production health returned `ok`; readiness returned `ready`; `/sygsphere` returned HTTP 200 on both origins.
- Live main asset `assets/index-DqwZt0e8.js` and SygSphere asset `assets/SygSpherePage-Cq-yr4nm.js` match the verified production build byte-for-byte.
- A signed-out request to the protected SygSphere completion endpoint returned HTTP 401.

## Release

- Application source: `25fa3f3` (`fix: route normal SygSphere files through signed upload`).
- Cloudflare Worker version: `4d30f3ce-6b8d-4808-8ec6-c2f126d78961`.
- Primary URL: `https://app.sygilant.us`.
- Fallback URL: `https://sygshift.sygilant.workers.dev`.

## Rollback

- Pre-release source tag: `rollback/pre-sygsphere-standard-upload-routing-repair-20260910` at `33ccf07`.
- This is an application-only release. If containment is required, restore the tagged application source and redeploy with the existing bindings preserved.
