# 07/31/2026 — Employee Announcement Delivery Lane

## Summary

Cleaned up the employee/guard announcement experience so employees no longer see the creator-facing Announcements workspace unless they have permission to send or manage announcements. Published announcements now flow into the employee-facing banner and Overview announcement cards with a configurable expiration date.

## What Changed

- Hid the Announcements sidebar route from users who can only view announcements.
- Kept the Announcements page available to users who can send approved messages or manage workspace banners.
- Added a required "Visible until" expiration field when publishing approved announcement templates.
- Updated announcement publishing so the selected expiration date is sent to Supabase instead of always saving a blank expiration.
- Added a Supabase delivery lane that converts active published announcements into front-page/banner announcement records.
- Added a 14-day safety expiration for old announcements that were posted without an expiration, so stale posts do not stay visible forever.
- Kept announcement visibility audience-aware:
  - Role-targeted announcements only show to the intended roles.
  - Armed-required announcements only show to employees with a valid armed credential on file.
  - Welcome/login-template emails stay out of the workspace announcement lane.
- Added guardrail test coverage so this employee/creator split does not regress.

## Validation

- `pnpm exec vitest run src/permissionSurfaceGuard.test.ts` — passed.
- `pnpm run build` — passed.
- `pnpm run lint` — passed.
- `pnpm test` — passed, 149 tests.
- Supabase migration `20260731162000_employee_announcement_delivery_lane.sql` applied to the linked production project and marked in migration history.
- Cloudflare Worker deployed successfully.

## Production

- Cloudflare Version ID: `1b8de1a1-15f8-4f12-9924-8e2f2748ac29`
- Live URL: `https://app.sygilant.us`
- Workers URL: `https://sygshift.sygilant.workers.dev`
