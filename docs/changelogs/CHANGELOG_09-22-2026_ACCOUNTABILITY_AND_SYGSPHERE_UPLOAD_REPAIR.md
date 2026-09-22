# 09/22/2026 - Accountability and SygSphere Upload Reliability

## Outcome

- Restored the complete Accountability Tracker in production. The same 22 occurrence records and 541 shift choices now load successfully.
- Reduced the live Accountability workspace query from approximately 9.7 seconds to approximately 0.12 seconds by loading schedule-versus-time reconciliation only when an authorized reviewer opens a specific occurrence.
- Preserved the original schedule, punches, action history, coverage evidence, permissions, and recent-MFA requirements. No attendance, schedule, time, payroll, or review record was rewritten.
- Routed every SygSphere attachment size through the existing protected resumable upload and background scanner queue. The share window now returns after the file reaches protected storage and the security check is queued instead of waiting on a cold scanner inside one browser request.
- Files remain unavailable to conversation participants until the scanner marks them clean. Rejected or failed scans remain private and keep the existing retry/recovery controls.

## Root causes

- Accountability rebuilt a full reconciliation snapshot for every row before showing the list. With current production volume, the valid response took longer than the authenticated API statement timeout.
- SygSphere files at or below 25 MB bypassed the resilient queue and waited synchronously for the ClamAV container. A cold scanner could outlive the request and leave the retained file in an error state even though the file itself was small.

## Release controls

- Applied only migration `20260922174500_accountability_lazy_reconciliation.sql` and recorded its migration ledger entry. A broad database push was intentionally not used because unrelated remote migrations from other active work are absent from this checkout.
- Source commit: `224dd3c`.
- Cloudflare Worker version: `4522090e-cc28-4a36-ae7c-d4d7fc874292`.
- Rollback tag: `rollback/pre-accountability-sygsphere-upload-repair-20260922`.

## Verification

- Full quality gate: 303 test files and 1,607 tests passed; strict TypeScript, zero-warning lint, production builds, and the static-asset contract passed.
- Focused SygSphere upload matrix: 6 desktop/mobile browser checks passed.
- Mandatory Time Clock preservation matrix: 42 desktop/mobile browser checks passed.
- Production Accountability list visibly loaded, and an opened occurrence visibly loaded its on-demand scheduled-shift context.
- Custom-domain and Worker-fallback health returned `ok`; readiness returned `ready: true`.
- The live application entry bundle and SygSphere page bundle were byte-identical to the verified production build.

