# Production Early Clock-In Restriction

Date: 09/02/2026  
Status: Released to production

## Outcome

Early clock-in attempts are now evaluated by trusted SygShift server time and return one structured `EARLY_CLOCK_IN_BLOCKED` response whenever the employee is earlier than five minutes before an assigned, published shift. No punch is created for a blocked attempt.

Every current clock-in entry point uses the same response and the same mandatory alert dialog:

- Home
- My Time
- Time & Attendance workspace header
- Responsive/mobile layouts for those surfaces
- Direct RPC callers receive the same structured domain response

## Employee experience

- The previous small inline warning has been replaced with a premium SygShift `alertdialog`.
- The dialog clearly shows the remaining wait, trusted current time, clock-in eligibility time, scheduled start, shift identity, Site/Post, date, and start/end time.
- It has no close icon, Cancel action, automatic retry, or automatic dismissal.
- Escape and backdrop clicks do not close it.
- The only action is **Acknowledge & close**, which is focused when the dialog opens.
- A short inline confirmation remains after acknowledgment and tells the employee when to try again.
- Acknowledgment never records a punch.

## Enforcement and audit controls

- The existing four-argument `record_time_event` contract was preserved; no overload or alternate bypass path was added.
- The database checks the authenticated employee, assigned/published shift, and exact server-time boundary before punch insertion.
- The exact eligibility boundary is allowed; any earlier attempt is blocked.
- Blocked attempts are audit-recorded with short-window deduplication so repeated clicks do not create audit noise.
- Unauthorized, canceled, or expired shifts do not expose schedule details through the early-clock response.
- Existing break, clock-out, idempotency, sequencing, timezone, and permission behavior remains unchanged.

## Verification

- Type checking and zero-warning lint passed.
- 150 unit/integration test files and 726 tests passed.
- All 80 desktop/mobile Playwright checks passed.
- Focused modal checks passed in light and dark mode at desktop and mobile sizes with no Axe accessibility violations.
- Production Worker and client builds passed.
- Migration `20260902194500_structured_early_clock_in_restriction.sql` was isolated in a linked dry run, then applied and verified in the production migration ledger.
- Deployed Cloudflare Worker version `ed096da4-e91a-4940-bfe6-f6657d76e44d`; production health, readiness, login, modal assets, and structured domain-code assets returned successfully.
