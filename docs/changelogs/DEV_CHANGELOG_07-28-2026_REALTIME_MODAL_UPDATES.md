# SygShift Dev Changelog — Real-Time Modal Updates

Date: 07/28/2026

## Purpose

This update standardizes how SygShift handles saves inside modals, popouts, and decision windows. The goal is to stop the old behavior where a user saves a change but has to close and reopen the window before the new information is visible.

## What changed

- Added a shared modal busy state with a visible loading spinner and clear status text.
- Prevented modal close/escape during active saves so users do not accidentally interrupt an update.
- Updated Schedule edit windows so saved draft-shift changes stay open and reload against the saved schedule record.
- Updated Scheduler assignment popouts so reassignment/override saves show loading and rebind to the refreshed shift data.
- Updated Schedule duplicate/open-shift removal, review resolution, draft-prep, and cancel-draft dialogs with consistent saving states.
- Updated Users & Access so employee profile modals are keyed by the latest employee data instead of stale data captured when the modal opened.
- Updated Directory/People credential and availability tools so saved credential and availability changes refresh inside the open profile workflow.
- Updated Licensing Center profile, credential, employee-profile, and communication modals so saved records refresh against the current cached employee record.
- Hardened Licensing Center editing so an employee edit modal cannot accidentally fall back into a blank new-employee form during a data refresh.
- Updated Roles & Permissions modals so role creation and per-person access edits show loading while updates are being saved.
- Updated Time-Off/Request decision dialogs, Import Review dialogs, and Operational Import dialogs to follow the same modal busy-state standard.

## User-facing result

- Users should see a loading indicator immediately after clicking a save/update/decision button in modal workflows.
- Edit windows should either update in place with the saved record or close only when the action is a completed confirmation workflow.
- Schedulers should not have to close and reopen shift editor windows to see saved schedule/assignment changes.
- Admins, supervisors, schedulers, and licensing staff get a more consistent “save is working / save finished” experience across the app.

## QA completed

- `pnpm typecheck` passed on 07/28/2026.
- `pnpm lint` passed on 07/28/2026.
- `pnpm test` passed on 07/28/2026 with 23 test files and 79 tests passing.
- `pnpm build` passed on 07/28/2026.

## Notes

- Some final confirmation dialogs still close after successful completion by design, such as approving/declining a request. Those workflows now show saving state first and refresh the underlying queue after completion.
- Hidden legacy import tools were also updated so they do not become inconsistent maintenance traps later.
