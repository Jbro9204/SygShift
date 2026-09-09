# Split-Shift Return and Request Notifications

Date: 09/09/2026

## Outcome

Employees can now clock out for an appointment or other unpaid interruption and return to the same assigned shift. SygShift records the return as a new time segment, labels the action **Resume work**, preserves the earlier clock-out, and excludes the time away from paid hours.

The personal Notification Center now receives actionable, permission-filtered work for every current user-submitted operational and HR approval workflow. Open workflow alerts remain visible until the source request is completed, while requesters receive privacy-safe outcome notifications.

## Timekeeping Behavior

- A clocked-out employee may resume only the same shift recorded on the immediately preceding clock-out.
- Normal clock-in availability remains unchanged while the shift is active.
- The same shift remains resumable for up to six hours after its scheduled end so a late return is not blocked by the schedule boundary.
- Another ended shift cannot be selected as a workaround.
- The return creates a new append-only `clock_in` event. The original `clock_in`, `break`, and `clock_out` events remain unchanged and auditable.
- Paid-time calculations continue to total the individual worked segments, leaving the appointment gap unpaid.
- Home, Time & Attendance, and the shared Time workspace use the same eligibility rule and **Resume work** label.

## Notification Coverage

The release adds centralized routing for:

- availability submissions;
- time-off requests;
- shift and coverage requests;
- call-offs, with urgent priority;
- punch-correction requests;
- missing-time and time-adjustment requests;
- employee HR document requests and submitted responses;
- employee HR service requests;
- double-controlled employee lifecycle actions;
- candidate-conversion approvals;
- compensation approvals;
- payroll-impacting approvals; and
- document-signature actions, using the existing signature delivery records.

Support tickets, announcements, SygTasks assignments, Action Center work, and existing delivery channels already had their own Notification Center or required-action paths and were preserved.

## Recipient and Privacy Controls

- Review alerts are routed from effective permissions, not role labels.
- Only active employees with active login accounts can receive workflow alerts.
- Supervisor-scoped operational requests honor existing employee-scope assignments.
- Directly assigned HR service work routes to the named authorized assignee.
- Requesters are excluded from independent approval work where maker-checker separation applies.
- Compensation and payroll alerts contain no pay values or protected proposal details.
- Requesters receive a status-only result after approval, denial, cancellation, resolution, or another terminal transition.
- An unresolved action cannot be dismissed or removed by **Clear all**. When the authoritative request resolves, the alert is marked completed and retained in history.
- Existing Realtime and protected push-delivery triggers carry these notification rows through the same live Notification Center infrastructure.

## Existing-Work Backfill

Open workflows were backfilled without changing their source records. Production contained 39 pending compensation proposals and four active authorized compensation reviewers. Rather than produce 156 individual alerts, SygShift created one consolidated compensation queue alert for each reviewer. The queue count is refreshed whenever a compensation proposal enters or leaves the pending state.

## Database

- Applied and recorded forward migration `20260910110000_time_segments_and_request_notifications.sql`.
- Added `action_required` and `resolved_at` to `public.employee_notifications` with an open-action index and data constraint.
- Installed 12 request-routing triggers plus signature classification and recipient-resolution triggers.
- Updated `record_time_event` through an exact reviewed function-definition patch. The migration aborts if the expected production guard does not match, preventing a silent rewrite of an unknown function version.
- Private routing helpers remain unavailable to browser roles; authenticated access remains limited to the existing public Notification Center functions.

## Verification

- `pnpm check`: passed TypeScript, zero-warning lint, 224 test files, 1,126 tests, and both production builds.
- Actual-component Time Clock matrix: 42/42 passed on desktop and mobile before release and 42/42 again after deployment. The matrix now covers a real clock-in, break, clock-out, and same-shift return from both Home and the Time workspace.
- Linked rollback-only database rehearsal: passed the exact migration plus lifecycle regression in one outer transaction with a final rollback.
- Post-migration rollback-only production lifecycle: passed append-only re-entry, expired-shift rejection, permission-aware reviewer routing, requester outcomes, action resolution, clear/dismiss protection, and RPC grants.
- Production inspection confirmed all 12 workflow triggers, the six-hour same-shift guard, migration history, four consolidated compensation queue alerts for four authorized reviewers, and zero per-proposal compensation alert flood.
- Zero rollback-test employees or time events persisted.
- Automatic Timekeeping runs immediately after release completed normally.
- Live `https://app.sygilant.us/api/v1/health` returned `status: ok`; readiness returned `ready: true`.
- Live entry asset `/assets/index-Duxa66Bn.js` matched the production build. The deployed Notification Center and Home/Time assets contain the new workflow categories, actionable state, and **Resume work** behavior.

## Release and Rollback

- Source commit: `5648265`.
- Pre-release rollback tag: `rollback/split-shift-notifications-pre-release-20260909` at `edc3f77`.
- Cloudflare Worker version: `7059b973-0e4d-4ded-9019-8dd2b2e7496f`.
- No production employee, schedule, punch, payroll, HR request, or source workflow record was rewritten by the release. The only intended existing-data additions were the permission-filtered open-workflow notifications described above.

## User-Present Acceptance

The automated and rollback-only workflows prove the behavior without clocking a real employee in or submitting a real HR request. The next genuine employee return and request submission can therefore serve as the user-present production canary without manufacturing operational records.
