# SygSphere Upload, PWA, and Header Refinement

Date: 09/09/2026

## Outcome

SygShift now has a complete installable-app experience, clearer device-notification controls, a more compact mobile SygSphere composer, and a recoverable background security-check workflow for every supported SygSphere attachment. The static operational date in the global header is also larger and easier to read.

Location services were intentionally left unchanged under the owner’s current direction.

## SygSphere Mobile Experience

- Reduced the idle composer height, outer margin, internal spacing, typing-status space, tool-button footprint, and Send-button height on small screens.
- Added controlled auto-growth for multiline messages while keeping the composer capped and the Send action visible above compact and keyboard-height viewports.
- Preserved drafts, Enter-to-send, Shift+Enter, mentions, emoji, file selection, threads, message history, and desktop behavior.

## Protected File Uploads

- Routed every supported SygSphere attachment through the existing private quarantine and asynchronous malware-scanning boundary instead of holding the browser open while a scan runs.
- Supported PDF, TXT, DOCX, XLSX, JPEG, PNG, and WebP through 25 MB; matching JPEG, PNG, and WebP images remain supported through 100 MB.
- Kept uploaded objects private until their exact signature/type validation and security scan pass.
- Preserved both the unsent message draft and selected local file when an upload is interrupted.
- Added clear uploading and security-check stages, safe request reference IDs, and personal Notification Center outcomes when a file becomes ready, is blocked, or needs attention.
- Retained a failed scan in private quarantine for a bounded recovery window and added up to two owner-only security-check retries without re-uploading the file.
- Kept object paths, scanner errors, storage capabilities, and service credentials out of browser status responses.
- Kept retry execution service-only. The browser can request a retry only through the authenticated same-origin Worker, which revalidates the active account, conversation membership, ownership, retained object, retry count, and expiry.

## Installable App and Device Notifications

- Added complete 192 px, 512 px, and maskable local PWA icons plus mobile install metadata.
- Added an **Install SygShift on this device** section to the existing Sounds & Device Notifications panel instead of creating a duplicate settings system.
- Uses the browser’s native install prompt where supported and gives platform-specific browser instructions otherwise.
- Centralized registration of the existing notification service worker so install and push setup use one origin-trusted path.
- Clarified whether push is unsupported, off, enabled for the signed-in account, or blocked by browser permission, with a direct recovery explanation.
- Installation does not bypass authentication, weaken MFA, or add an offline cache for protected SygShift records.

## Global Header

- Increased the static SygShift date to 16 px and its calendar icon to 20 px in the shared operational header.
- Preserved the four operational clocks, Mountain system-time authority, responsive containment, theme behavior, and accessibility state.

## Database and Security

- Applied and recorded forward migration `20260911013000_sygsphere_async_upload_recovery.sql`.
- Added bounded retry evidence, request correlation, upload/scan/completion timestamps, failure-stage evidence, and retained-error expiry indexing to the private SygSphere upload queue.
- Replaced the affected service functions without granting direct execution to `authenticated` or `anon`.
- Production verification confirmed the new migration record and retry column, service-role retry access, and denied browser-role retry access.
- The rollback-only production lifecycle passed conversation authorization, small-file authorization, private upload transition, five interrupted scan attempts, retained-error recovery, retry without re-upload, terminal cleanup protection, and grant checks. The transaction rolled back and created no persistent test message, file, or notification.

## Verification

- `pnpm check`: passed TypeScript, zero-warning lint, 226 test files, 1,132 tests, and both production builds.
- Focused source and Worker guards: 24/24 passed.
- Responsive browser matrix: 114/114 passed across desktop and mobile, including the complete actual-component Home and Time workspace clock-in, early-warning, break, clock-out, and same-shift resume workflow.
- Mobile composer growth regression: 2/2 passed after the final sizing adjustment.
- Live health returned `status: ok`; readiness returned `ready: true` with every configured dependency ready.
- Live entry asset `/assets/index-Bk15JedA.js`, stylesheet `/assets/index-CL5iTCbJ.css`, manifest, notification service worker, and PWA icon all loaded successfully.
- Live signed-in SygSphere loaded the protected conversation workspace, the deployed static date measured 16 px, and the idle composer measured 48 px.
- The signed-out SygSphere scan-retry route returned HTTP 401.

## Release and Rollback

- Source commit: `7aa98c6`.
- Pre-release rollback tag: `rollback/sygsphere-pwa-pre-release-20260909` at `633597d`.
- Cloudflare Worker version: `0852be11-1a59-406d-8ce8-396a7429e06d`.
- Production application: `https://app.sygilant.us`.
- No employee, message, schedule, punch, payroll, HR, role, permission, MFA, or existing attachment record was rewritten by this release.

## User-Present Acceptance

The automated browser matrix and rollback-only live database lifecycle prove the complete workflow without manufacturing a production conversation file. The next genuine SygSphere attachment can serve as the user-present production canary; its uploader should be able to leave the page after upload and receive a Notification Center result when scanning completes.
