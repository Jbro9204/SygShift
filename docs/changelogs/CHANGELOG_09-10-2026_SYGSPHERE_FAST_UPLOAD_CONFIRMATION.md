# SygSphere Fast Upload Confirmation

Date: 09/10/2026

## Outcome

Normal SygSphere document and image uploads now finish their user-facing confirmation promptly instead of holding the **Share a file** dialog open through stacked storage retry loops. The file remains private and its malware scan continues asynchronously after the successful transfer is accepted.

## Root cause and repair

- SygSphere already used the correct signed standard upload path for files through 6 MiB and signed resumable transfer for larger files.
- After transfer, the browser could make five delayed completion attempts while every Worker attempt separately performed four delayed object-visibility checks. Those nested loops could add roughly 10–13 seconds before the background scan even began.
- Reduced ordinary browser confirmation to two attempts separated by 250 milliseconds.
- Reduced each Worker storage-visibility check to three attempts with 100- and 300-millisecond delays.
- A successful first visibility check remains immediate. The maximum deliberate retry sleep before recovery is offered is now approximately 1.05 seconds, excluding ordinary network and validation time.
- If storage is genuinely slower, the existing **Check upload** action remains available and completes the same upload without requiring the employee to select or transmit the file again.

## Security and scope

- Preserved private quarantine storage, content validation, asynchronous ClamAV scanning, audit records, participant-only access, download authorization, scan-result notifications, and native retry recovery.
- Preserved the 6 MiB standard-upload boundary and 100 MiB supported attachment ceiling.
- No database migration, storage policy change, role change, permission change, message behavior change, or production-data mutation was required.
- Upload completion continues to require authentication; signed-out completion requests return HTTP 401.

## Verification

- Focused data, Worker, and architecture checks: 32/32 passed.
- SygSphere real-component browser coverage: 46/46 desktop/mobile checks passed, including normal PDF transfer, transient confirmation lag, completion-only recovery, layout, dark mode, messaging, mentions, and Realtime behavior.
- `pnpm check`: passed TypeScript, zero-warning application lint, 230 test files, 1,190 tests, Worker build, and client production build.
- Mandatory Time Clock workflow before deployment: 42/42 desktop/mobile checks passed.
- Required fresh production build passed immediately before deployment.
- Mandatory Time Clock workflow after deployment: 42/42 desktop/mobile checks passed.
- Primary and fallback production health returned `ok`; readiness returned `ready`; `/sygsphere` returned HTTP 200 on both origins.
- Live main JavaScript, global CSS, and SygSphere page assets match the verified production build byte-for-byte on both origins.
- Signed-out upload completion returned HTTP 401 on both origins.

## Release

- Application source: `182dcd9` (`fix: finish SygSphere uploads promptly`).
- Cloudflare Worker version: `3e647311-ff96-4981-a90a-1cd5718cc1a6`.
- Primary URL: `https://app.sygilant.us`.
- Fallback URL: `https://sygshift.sygilant.workers.dev`.

## Rollback

- Pre-release source tag: `rollback/pre-sygsphere-fast-upload-confirmation-20260910` at `2a23eae`.
- This is an application-only release. If containment is required, restore the tagged application source and redeploy with the existing bindings preserved.
