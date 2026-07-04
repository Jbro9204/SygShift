# SygShift pilot test plan

This plan is the safest way to prove SygShift with real people before a full company rollout.

## Pilot goal

Confirm that supervisors and guards can use SygShift for the daily operating work without confusion:

- read the schedule
- resolve imported schedule review items
- request time off
- accept open shifts and events
- clock into the correct shift, site, or event
- review time records before payroll
- send supervisor-approved announcements

The pilot should be small enough to watch closely, but realistic enough to expose workflow problems.

## Recommended pilot group

Use one operating week first.

- 1 admin
- 1 to 2 supervisors
- 5 to 10 guards
- at least 2 armed-qualified guards
- at least 1 unarmed-only guard
- at least 2 sites with normal recurring coverage
- at least 1 event or open-shift announcement

Do not start with every employee. The first week is for finding friction before it reaches the whole workforce.

## Before the pilot starts

Complete these checks:

- The latest source schedule has been imported and promoted.
- All active pilot employees have logins.
- Admin and supervisors have MFA enabled.
- Guard roles are correct.
- Armed qualifications are correct.
- Sites and posts are readable and assigned correctly.
- Review-needed schedule items for the pilot week have been resolved or intentionally left open.
- Cloudflare Email Sending is configured if announcement email delivery is being tested.
- Payroll reviewer has confirmed the expected export fields.

## Pilot script

### Day 1: supervisor schedule cleanup

The supervisor should:

1. Open Master Schedule.
2. Use the Supervisor cleanup workbench.
3. Resolve each review-needed item for the pilot week.
4. Confirm the schedule board is easy to read after cleanup.
5. Make one safe schedule change and confirm the published schedule updates.

Pass condition: the supervisor can resolve the source data without needing technical help.

### Day 2: guard schedule review

Pilot guards should:

1. Sign in.
2. Open their schedule.
3. Confirm they understand where, when, and what they are working.
4. Confirm armed/unarmed restrictions make sense.
5. Report any confusing labels.

Pass condition: guards can tell what they work without needing to understand the original workbook.

### Day 3: time clock

Pilot guards should:

1. Clock into an assigned shift.
2. Clock out.
3. Clock into one site or event when applicable.
4. Confirm their time entry appears in the timekeeping review area.

Supervisors should:

1. Review entries.
2. Identify late, missed, edited, or unusual entries.
3. Confirm any correction workflow is understandable.

Pass condition: time records can be reviewed before payroll without guessing.

### Day 4: time off and open shifts

Pilot guards should:

1. Submit at least one time-off request.
2. View an open shift or event opportunity.
3. Accept an eligible opportunity.
4. Confirm they cannot accept an opportunity they are not qualified for.

Supervisors should:

1. Review the request.
2. Publish or review an announcement.
3. Confirm the schedule reflects accepted work correctly.

Pass condition: requests and opportunities do not require side spreadsheets to understand.

### Day 5: payroll dry run

The payroll reviewer should:

1. Export the pilot week.
2. Compare exported hours to approved time records.
3. Confirm regular, overtime, edited, missed, and manually corrected records are visible.
4. Confirm the export is acceptable for the payroll process.

Pass condition: payroll can explain every paid hour from SygShift records.

## Issues to track

Track every issue with:

- who found it
- exact page or workflow
- what they expected
- what happened
- whether it blocks payroll, scheduling, or daily use
- screenshot if useful
- fixed date
- retest result

## Go/no-go decision

Move to a wider rollout only when:

- no payroll-blocking issues remain
- no security-blocking issues remain
- guards can read the schedule without workbook context
- supervisors can resolve review-needed schedule items
- time records can be explained and exported
- login, password reset, and MFA flows are understood
- owner-only Cloudflare and Supabase setup items are complete

If the pilot exposes confusion, fix the workflow before adding more users.
