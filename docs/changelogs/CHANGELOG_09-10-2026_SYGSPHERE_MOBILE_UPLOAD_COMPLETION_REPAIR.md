# SygSphere Mobile Upload Completion Repair

Date: 09/10/2026

## Outcome

SygSphere mobile attachments no longer fail when the resumable transfer finishes slightly before Supabase private storage exposes the completed object to the Worker. The existing private upload and security-scanning workflow remains in place, and a prolonged confirmation delay can be recovered without selecting or transferring the file again.

## Root cause corrected

- The mobile client correctly completed its resumable upload, then immediately asked the Worker to finalize it.
- The Worker performed one private-storage `HEAD` request. A brief post-upload visibility delay therefore returned `sygsphere_file_not_stored` even though the transfer had finished.
- The client presented that transient completion race as a terminal upload failure and labeled the action `Retry upload`, which implied that the employee had to transfer the attachment again.

## Application changes

- Added bounded Worker-side private-storage confirmation for newly completed resumable uploads. Only a `404` is retried; authorization, service, and other storage failures still fail closed immediately.
- Added a bounded client-side finalization retry so normal mobile storage latency resolves automatically.
- Preserved the secure upload identifier, selected file, draft message, and request reference if confirmation takes longer than the bounded retry window.
- Replaced the misleading retransmission action with **Check upload** for this exact state. It reruns finalization only and does not reselect, recreate, or retransmit the file.
- Kept existing upload progress, quarantine, asynchronous scanning, participant access, download controls, and Notification Center outcomes unchanged.

## Preservation boundary

- No database migration was added or applied.
- No storage policy, row-level security policy, permission, role, MFA, participant, message, conversation, notification, timekeeping, schedule, payroll, HR, or employee record changed.
- Files remain in private quarantine until the existing security check passes.
- Unsupported types, oversized files, authorization failures, scanner failures, and rejected files retain their existing fail-closed behavior.

## Verification

- Focused SygSphere data/Worker tests: 24/24 passed.
- `pnpm check`: passed TypeScript, zero-warning application lint, 229 test files, 1,182 tests, Worker build, and client production build.
- Mobile SygSphere upload workflow: 19/19 checks passed.
- Combined SygSphere and mandatory actual-component Time Clock browser matrix: 86/86 desktop/mobile checks passed against the integrated current `main` branch.
- The browser regressions prove both automatic recovery from a transient completion delay and completion-only recovery after a prolonged delay without retransmitting the selected file.
- Required fresh production build after browser testing: pending release step.
- Post-deployment mandatory Time Clock workflow: pending release step.
- Production health, readiness, route, and exact live asset verification: pending release step.

## Release

- Application source: pending.
- Cloudflare Worker version: pending.
- Primary URL: `https://app.sygilant.us`.
- Fallback URL: `https://sygshift.sygilant.workers.dev`.

## Rollback

- Pre-release source tag: `rollback/pre-sygsphere-mobile-upload-repair-20260910` at `eb8d9ce`.
- This is an application-only release. If containment is required, restore the tagged application source and redeploy with the existing bindings preserved.
