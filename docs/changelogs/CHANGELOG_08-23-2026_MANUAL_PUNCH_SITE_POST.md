# Manual Punch Site/Post Completion

Date: 08/23/2026

## What changed

- Added a required Site/Post field to the Time Maintenance **Add Missing Punch** workflow.
- Organized the choices into employee-assigned shifts and other scheduled Site/Posts for the selected employee and date.
- Added a controlled **Other location** choice for verified work that does not correspond to an existing schedule block.
- Kept Site/Post choices synchronized when the employee or punch date changes so stale shift selections cannot be submitted.
- Carried the Site/Post forward when an authorized user chooses **Add punch** from an existing event.

## Data integrity and security

- Added production function `supervisor_record_time_event_with_location` through forward-only migration `20260823170000_manual_time_event_site_post.sql`.
- The punch, maintenance reason, and scheduled Site/Post or verified Other location now save in one database transaction.
- Exactly one location path is required. Invalid, canceled, or unavailable shifts are rejected before a punch is written.
- Existing `time.manage` permission and MFA enforcement remain at the database boundary.
- Every supervisor-entered punch retains its append-only maintenance reason and actor identity.
- Manual locations use the existing append-only location override history; original time events are not rewritten.

## User experience

- The **Add time event** action remains unavailable until employee, punch type, date, time, Site/Post, and reason are complete.
- A successful save refreshes Time Maintenance immediately and avoids the previous second Site/Post correction step.
- The new location panel uses the established responsive form system and was verified at desktop and phone widths without horizontal overflow.

## Validation

- Full `pnpm check` passed, including type checking, lint, all automated tests, and production build.
- New manual Site/Post unit and database-boundary tests passed.
- Time Maintenance browser layout checks passed in desktop Chromium and mobile Chromium.
- Production database function installation was verified after the targeted migration completed.
- Deployed Cloudflare Worker version `6b959ca8-ca47-411b-baa4-c96d700126a7`.
- Live health, readiness, and application route checks passed.
