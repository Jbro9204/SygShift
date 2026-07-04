# Rollout status - July 4, 2026

## Current deployment

- Live app: https://sygshift.sygilant.workers.dev
- Company domain: sygilant.us
- Notification sender: SygShift <scheduling@sygilant.us>
- GitHub repo: https://github.com/Jbro9204/SygShift
- Latest verified Cloudflare Worker version: `ce944e84-391c-42fd-a61e-c1684f4cab87`
- Latest pushed commit: see Git history for the current rollout-status revision.

## Verification completed

The following checks passed after the supervisor schedule-review and notification delivery workflows were added:

- TypeScript typecheck
- Lint
- Unit tests
- Production build
- Browser/e2e tests on desktop and mobile
- Live `/schedule` smoke check
- Live `/api/v1/ready` check
- Git source scan for pasted secrets
- Git source scan for development-tool authorship traces
- Supabase migration history check
- Supabase RLS/table posture check

## Database posture

Current verified counts:

- Total employees: 54
- Active employees: 46
- Active employees with linked logins: 46
- Active employees missing login: 0
- Active admin accounts: 1
- Public tables without RLS: 0
- Private tables without RLS: 0

## Current schedule posture

The Bible schedule has been promoted into operational schedule tables.

Current published schedule weeks:

| Week starts | Revision | Shifts | Open shifts | Review needed |
| --- | ---: | ---: | ---: | ---: |
| 2026-06-28 | 1 | 138 | 64 | 64 |
| 2026-07-05 | 1 | 138 | 61 | 61 |
| 2026-07-12 | 1 | 146 | 87 | 87 |
| 2026-07-19 | 1 | 141 | 73 | 73 |
| 2026-07-26 | 1 | 138 | 70 | 70 |
| 2026-08-02 | 1 | 131 | 67 | 67 |
| 2026-08-09 | 1 | 131 | 67 | 67 |

Future open shifts as of this report:

- Future open shifts: 432
- Future review-needed shifts: 432
- Future armed open shifts: 170

These are intentionally not auto-assigned because the workbook source required human review. Supervisors can now use the schedule review filter, the Supervisor cleanup workbench, and the resolve action to publish each correction into a new schedule revision.

## Supabase advisor notes

Supabase security advisor reported:

- Informational notices for private tables with RLS enabled and no policies.
  - This is expected for private schema tables that are not directly exposed to browser users. With RLS enabled and no policies, direct table access is denied by default.
- Warnings for authenticated users being able to execute `SECURITY DEFINER` functions.
  - This is expected for app RPCs such as schedule review, timekeeping, requests, and admin workflows.
  - These functions perform their own role and MFA checks before making privileged changes.

Supabase performance advisor reported:

- Unused-index informational notices.
- Multiple-permissive-policy warnings on some public tables.
- Auth connection allocation informational notice.

These are not blocking launch findings, but they should be reviewed after real usage patterns are available. Removing indexes before production traffic would be premature because many indexes support planned workflows that may not have enough usage yet.

## Notification delivery status

Supabase now has service-only notification claiming and delivery-result functions.

The Worker now has an admin/MFA-protected processor endpoint:

`POST /api/v1/admin/notifications/process`

Cloudflare Email Sending is enabled for `sygilant.us`. The Worker is configured with the `EMAIL` binding, branded sender variables, and a SygShift HTML email shell that includes the email-optimized hosted logo, readable body area, app button, and plain-text fallback. Send only controlled internal tests before enabling broad employee announcements.

## Remaining account-owner actions

These items cannot be fully completed from code alone:

1. Rotate credentials that were pasted into chat or copied through any non-secure channel.
2. Confirm hosted Supabase Auth leaked-password protection in the Supabase Dashboard.
3. Send controlled internal email tests and confirm sender display/deliverability.
4. Run a small pilot with one admin, one supervisor, and a few guards.
5. Complete the payroll export validation plan with the person responsible for payroll.
6. Have supervisors resolve the review-needed Bible schedule shifts.

## Practical next operating step

Start with the week of 2026-07-05.

In the app:

1. Sign in as an admin or supervisor.
2. Open the master schedule.
3. Start with the Supervisor cleanup workbench.
4. Resolve each review-needed shift by assigning the correct employee.
5. Use Show review needed only if the supervisor wants the full board view.
6. Save each resolution.

Each resolution creates a new published schedule revision and keeps the previous revision in history.

Use [PILOT_TEST_PLAN.md](PILOT_TEST_PLAN.md) for the first controlled rollout and [PAYROLL_EXPORT_VALIDATION.md](PAYROLL_EXPORT_VALIDATION.md) before any payroll run depends on SygShift exports.
