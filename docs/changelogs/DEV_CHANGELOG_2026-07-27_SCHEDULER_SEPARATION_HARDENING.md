# SygShift Dev Changelog — July 27, 2026

## Production-hardening update

This update focused on scheduler usability, separated-employee access control, and reducing confusing active-schedule noise.

### Scheduler editing

- Replaced the selected-shift side/bottom panel workflow with a large centered modal.
- Added a cleaner selected-shift summary showing date, time, coverage, and armed/unarmed requirement.
- Kept the assignment tools, suggested staffing, review actions, full editor, and remove-shift action in one clear working window.
- Added unsaved-change protection to the selected-shift modal.
- Added unsaved-change protection to the full shift editor.
- Removed the unused “select a shift” panel from the scheduler board so the board stays focused.

### Schedule publish notifications

- Added controlled schedule-update notification queueing when a draft schedule is published.
- The system now queues one idempotent `schedule_published` notification per published revision instead of sending scattered emails during individual edits.
- Schedule-published notifications use the existing private notification outbox and Cloudflare email processor.
- Recipients are intentionally scoped to:
  - active employees assigned to that published week,
  - active dispatchers,
  - active schedulers,
  - active supervisors,
  - active admins.
- The email content includes the week range, schedule revision, assigned-shift count, and open-slot count.
- This keeps schedule communication controlled: edits stay in draft, publishing queues the update, and the existing Notifications workflow handles delivery.

### Scheduler active-shift filtering

- Updated scheduler planning views to exclude shifts dated before the current organization-local operational date.
- Applied the filtering to:
  - scheduler staffing work items,
  - scheduler day buckets,
  - site coverage groups,
  - site/location summaries,
  - scheduler visible totals.
- Historical shifts are still preserved for normal schedule history, payroll, reports, and audit use.

### Employee separation and access control

- Added a database-side separation workflow that treats employee separation and account lockout as one connected action.
- When an employee is separated, the database now:
  - marks the employee as separated,
  - disables their SygShift account,
  - records who separated them and when,
  - revokes trusted/remembered devices,
  - releases future assigned shifts back to open coverage when needed,
  - cancels pending future shift requests,
  - preserves historical employee, payroll, schedule, and audit records.
- Updated the admin employee-save workflow so changing an employee status to `Separated` triggers the same lockout and cleanup logic.
- Hardened the active Directory database payload so separated employees no longer return from the standard Directory endpoint.

### Database changes

- Added `private.employee_separation_events` for separation audit history.
- Added account-disable metadata fields on `private.employee_accounts`:
  - `disabled_by`
  - `disabled_reason`
- Added `public.admin_separate_employee(...)`.
- Replaced `public.admin_update_employee(...)` so `Separated` status is enforced as an access-disabling workflow.
- Replaced `public.get_employee_directory()` so standard Directory results only include active/on-leave employees.
- Replaced `public.publish_schedule_draft(...)` so publishing a schedule also queues a controlled schedule-update notification.
- Replaced `public.service_claim_notification_batch(...)` so the worker can render and send queued schedule-published notices.
- Replaced `public.remove_schedule_draft_shift(...)` so duplicate/open-shift removals create an explicit audit event.
- Duplicate/removal workflow remains safe-delete based: removed shifts are canceled and hidden from schedule/open-pool views, not physically erased.

### QA completed

- TypeScript check passed.
- Lint passed.
- Automated tests passed: 78/78.
- Production build passed.
- Supabase migrations applied successfully.
