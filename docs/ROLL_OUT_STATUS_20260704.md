# Rollout status — July 4, 2026

## Current deployment

- Live app: https://sygshift.sygilant.workers.dev
- GitHub repo: https://github.com/Jbro9204/SygShift
- Latest verified Cloudflare Worker version: `d29d0c0f-b9d3-4889-a090-f16cb4f60e37`
- Latest pushed commit at time of this report: `3d05526`

## Verification completed

The following checks passed after the supervisor schedule-review workflow was added:

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

These are intentionally not auto-assigned because the workbook source required human review. Supervisors can now use the schedule review filter and resolve each item into a new published schedule revision.

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

## Remaining account-owner actions

These items cannot be fully completed from code alone:

1. Rotate credentials that were pasted into chat or copied through any non-secure channel.
2. Confirm hosted Supabase Auth leaked-password protection in the Supabase Dashboard.
3. Confirm production email sender/domain setup for announcements and overtime/open-shift notifications.
4. Run a small pilot with one admin, one supervisor, and a few guards.
5. Confirm payroll export format with the person responsible for payroll.
6. Have supervisors resolve the review-needed Bible schedule shifts.

## Practical next operating step

Start with the week of 2026-07-05.

In the app:

1. Sign in as an admin or supervisor.
2. Open the master schedule.
3. Turn on “Show review needed only.”
4. Open each review-needed shift.
5. Assign the correct employee.
6. Save the resolution.

Each resolution creates a new published schedule revision and keeps the previous revision in history.
