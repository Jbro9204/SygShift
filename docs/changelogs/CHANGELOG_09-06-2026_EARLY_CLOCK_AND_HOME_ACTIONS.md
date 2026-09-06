# Early Clock-In and Home Clock Actions

**Date:** September 6, 2026

## Cause reproduced

- The clock dashboard only returned assignments starting within 12 hours. Fourteen active linked employees had a later published assignment outside that window and no current clockable assignment during diagnosis.
- Home replaced its Clock in button with View next shift when the dashboard contained no upcoming assignment.
- The Time workspace could still submit Clock in with no shift ID. The server searched only the five-minute eligibility window and raised a plain-text error when none was found. That bypassed the structured `EARLY_CLOCK_IN_BLOCKED` response used to open the acknowledgment dialog.
- A linked rollback test reproduced the difference: the same future assignment produced a small error with no shift ID, but the full structured warning when its ID was supplied.
- Clock out and break actions had not been deleted. Their existing active-session behavior remains intact. Home also failed to explain a clock-dashboard query error and now provides a safe retry path.

## Changes

- Retained the dashboard's existing time window and added the nearest later published paid assignment.
- A default clock-in request now resolves the next eligible assigned paid shift before returning the existing structured early warning. It does not allow an early punch or use the employee's device time as payroll time.
- Retained Clock in on Home even when no shift is in the dashboard. Multiple current assignments still require explicit selection; no assignment produces accurate guidance, not invented shift details.
- Preserved Clock out, Start break, and End break according to the actual active session, including when schedule metadata is missing.
- Disabled punches while clock status is unavailable, with explicit retry controls on Home and the Time workspace. Access permissions are unchanged.
- Kept concurrent Dispatch phone duty excluded from separate paid sessions, including the new default-shift lookup.
- Added real React component/browser regression coverage to the standard release suite and an explicit all-release timekeeping guard in repository instructions.

## Verification

- `pnpm check`: type checking, zero-warning lint, 176 Vitest files / 841 tests, production build passed.
- Full Playwright suite: 170 desktop/mobile checks passed, including 38 new actual-component workflow checks. Existing support, HR, scheduling, header, modal, and pagination checks remain green.
- Actual dialog screenshots inspected in dark desktop and light mobile modes. Required acknowledgment, Escape prevention, repeat attempts, and visible action placement passed.
- Linked database runtime tests passed: next shift beyond 12 hours; default/explicit/repeated early responses; no early punch; five-minute boundary; server-authoritative time; idempotent retry; duplicate active-clock protection; break/resume/clock-out; concurrent Dispatch exclusion; anonymous denial and unchanged function execution permissions.
- All runtime punch/schedule/audit test changes rolled back. Original time-event fingerprint was unchanged after the nested lifecycle tests; a separate live check found zero persisted test punches and zero persisted test audits.
- The function-only migration applied during verification, before the web release. The initial combined verification file retained the migration's COMMIT; the subsequent runtime test block was separately rolled back. This was verified explicitly, the migration was not replayed, and only its exact applied version was recorded in migration history. Future rehearsal files must be checked for transaction boundaries before execution.
- Security advisor reported no error-level findings before web deployment.

## Release

- Applied and recorded migration `20260906175644_restore_early_clock_and_home_actions.sql`.
- Pushed application commit `a93ddb3` to `origin/main` and deployed Cloudflare Worker `5e35b1f9-2814-40c1-aa9c-a7eefef8e953`.
- Production health returned `status: ok`; readiness returned `ready: true`. The deployed Home and Time workspace JavaScript both returned HTTP 200 and exactly matched the verified local build. Function lint found no error-level issues, migration history contains the exact applied version, and the standalone rollback-only database lifecycle suite passed again after application.
- A signed-in production browser walkthrough is unavailable because the accessible browser remains signed out. Real rendered interaction testing used isolated RPC transport; authoritative behavior was exercised directly against production functions in rollback-only tests.
