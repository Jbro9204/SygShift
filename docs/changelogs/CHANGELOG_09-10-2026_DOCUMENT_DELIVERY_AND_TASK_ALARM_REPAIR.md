# Direct Document Delivery and Task Alarm Repair

Date: 09/10/2026

## Problem and user impact

Document Studio forced an authorized HR user through vault, policy, and template concepts before they could upload and send an ordinary outside document. That made proposals and other legitimate files unnecessarily difficult to route for signature or acknowledgment. Separately, a SygTasks alarm could remain muted, repeated on an approximate timer measured from playback start, and stopped locally when its task was opened. Alarm volume was also tied to quieter login and notification sounds.

## Root cause

The employee-signature control plane was complete, but its primary interface exposed administrative implementation details as required workflow. The upload and signature-request screens were separate, and the old request modal supported one recipient. SygTasks used the general sound preference and a fixed interval rather than waiting for the supplied audio to finish before starting the required delay.

## Functional behavior after the change

- Document Studio opens on a task-oriented Start workspace with separate **Upload for records only** and **Send a document** actions.
- The guided delivery path uses four visible steps: **Document**, **People**, **Review**, and **Send**.
- An authorized user chooses a supported outside file first. SygShift defaults ordinary filing to the compatible `hr-general` protected vault and keeps employee association, specialized vault choice, and description under optional filing details.
- The sender may choose one to 25 active or leave-status employees and require signature, acknowledgment, approval, certification, or review. All selected recipients can begin at the same routing level.
- SygShift uploads through the existing private document boundary, waits for the exact returned document version to pass malware and integrity review, applies the active standard employee electronic-signature policy, creates the request idempotently, sends it, and refreshes Document Studio, My Documents, and Notification Center state.
- A failed or rejected scan does not send a request. A post-upload send failure can be retried without creating a duplicate envelope.
- Existing-document requests, reusable templates, policy administration, processing status, signature evidence, final rendition, and audit certificates remain available and unchanged.
- Scheduling or receiving an active SygTasks alarm automatically enables alarm audio and restores a nonzero alarm volume on that device. Browser audio permission remains an enforced platform boundary and produces an explicit enable control when necessary.
- The complete supplied alarm sound plays, followed by exactly three seconds of silence, then repeats. Opening the task does not stop it. Stop, Snooze, completion, cancellation, archive, reassignment, or loss of account eligibility retains the existing authoritative lifecycle behavior.
- Task alarms now have their own device volume control, defaulting to 100%, separate from login and ordinary notification volume.

## Security and preservation

- No database schema, migration, account, role, permission, employee, document, task, reminder, signature, schedule, shift, punch, timecard, payroll, or notification record was changed by this release.
- Existing private Supabase Storage buckets, server-side authorization, forced RLS, quarantine, malware scanning, immutable document versions, recent-MFA enforcement, one-time access grants, and audit trails remain authoritative.
- External signers, OCR, native PDF editing, irreversible redaction, regulated-document automation, and organizational seals remain fail-closed.
- SygTasks retains its server-authoritative occurrence lifecycle, private recipient checks, Realtime invalidation, and single-tab sound lease.

## Primary files changed

- `src/components/DocumentSignatureWizard.tsx`
- `src/components/DocumentStudioDashboard.tsx`
- `src/pages/HrisDocumentsPage.tsx`
- `src/components/SygTasksAlarmHost.tsx`
- `src/components/sygtasks/SygTasksRemindersPanel.tsx`
- `src/components/NotificationPreferences.tsx`
- `src/lib/notificationSounds.ts`
- associated responsive styles, unit/guard tests, and Document Studio browser fixtures
- `docs/ARCHITECTURE.md`, `docs/future-items/FUTURE_ITEMS.md`, and `DEVLOG.md`

## Verification

- Targeted document-delivery, document-pipeline, alarm-host, sound, theme, and guard regression tests: **36/36 passed** before the full suite.
- Document Studio rendered layout and accessibility matrix: **12/12 passed** across desktop/mobile and light/dark modes.
- SygTasks rendered layout, dialog, accessibility, and 200% reflow matrix: **10/10 passed**.
- Pre-release actual-component Time Clock preservation matrix: **42/42 passed** across desktop and mobile, including early clock-in, punch controls, split-shift return, ambiguity handling, duplicate prevention, role boundaries, and both themes.
- `pnpm check`: passed TypeScript, zero-warning application lint, **231 test files / 1,193 tests**, and fresh Worker/client production builds after integration with the latest upstream releases.
- `git diff --check`: passed.

## Database status

No migration was needed or applied. The implementation deliberately reuses the released protected document, signature-envelope, employee notification, SygTasks reminder, and sound-preference boundaries.

## Release status

- Application source commit: `2f8ee5f` (`fix: simplify document delivery and strengthen task alarms`), pushed to `origin/main` after rebasing onto the latest upstream SygSphere and compensation releases.
- Rollback tag: `rollback/pre-document-delivery-task-alarm-repair-20260910` at pre-release source `506b4fe`, pushed to origin.
- Cloudflare Worker version: `17397cfe-66c0-454c-9bc4-76839f949a4f`.
- Primary `https://app.sygilant.us` and fallback `https://sygshift.sygilant.workers.dev` roots, `/hr/documents`, and `/tasks` returned HTTP 200; health returned `ok` and readiness returned `true` on both origins.
- Live `index-GbXp0kda.js`, `index-D7gd4tdq.css`, `HrisDocumentsPage-BzgRMEl3.js`, and `SygTasksPage-Bwf7VCl7.js` matched the final local production build by SHA-256.
- Mandatory post-deployment actual-component Time Clock preservation matrix: **42/42 passed** across desktop and mobile.

## Remaining limitations

Custom repeating MP3 playback requires an open SygShift browser or installed web-app process and is subject to browser audio permission. When SygShift is closed, background delivery remains a browser/device notification controlled by the operating system. Advanced editing and external-signature capabilities remain intentionally unavailable until their independent legal, security, and recovery gates are approved.
