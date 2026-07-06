# SygShift build explanation

## What SygShift is

SygShift is a secure workforce operations system for security scheduling. It takes the company’s existing master workbook and turns it into a cleaner, easier-to-use application for supervisors, guards, and administrators.

The goal is not to replace the company’s process with something unfamiliar. The goal is to keep the useful structure they already have, remove confusion, reduce manual mistakes, and make the information easier to read, update, and act on.

## What the system handles

SygShift currently covers these core areas:

- Schedule by week, site, post, event, and guard assignment
- Open shifts and overtime opportunities
- Events that guards can request to work
- Employee directory with roles, usernames, employment details, and qualifications
- Armed/unarmed qualification safeguards
- Supervisor review for schedule items that could not be matched safely from the workbook
- Time-Off Requests
- Call-off reporting and replacement-opening workflow
- Time clock and timekeeping review
- Payroll-ready export preparation
- User login and access roles for guards, supervisors, and admins
- Admin tools for creating employee logins and resetting temporary passwords

## What has been done with the workbook

The current workbook schedule has been imported into the live database and promoted into the operational schedule tables.

The promotion was handled carefully:

- Sites and posts were created from the workbook structure.
- Weekly schedules were created and published.
- Shifts were created from the workbook schedule.
- Safe employee matches were assigned automatically.
- Any assignment that was ambiguous, overlapping, or unsafe was left open and marked for supervisor review.
- Original workbook source details were preserved on review-needed shifts, including the workbook assignee, source row, sheet, and cell reference.

This matters because the system does not guess when the source data is unclear. It shows supervisors exactly what needs attention.

## How different employees use it

### Guards

Guards can:

- Sign in securely
- View schedules they are allowed to see
- Request time off
- View open shifts and events they are qualified for
- Request to work eligible openings
- Report a call-off for an assigned shift
- Use the time clock and view their time records

Armed work is protected so unarmed guards are not shown or allowed to request armed openings.

### Supervisors

Supervisors can:

- View the schedule
- Add open shifts or one-time events
- Review time-off requests
- Review open-shift requests
- Publish replacement openings after call-offs
- Review schedule items that came from the workbook but need human confirmation
- Review timekeeping corrections and payroll preparation items

### Admins

Admins can:

- Do everything supervisors can do
- Manage employee user accounts
- Create missing employee logins
- Reset temporary passwords
- View protected user-management tools

## Security approach

The system is designed around protected access, not public spreadsheets.

Security controls include:

- Login required for operational data
- Role-based access for guards, supervisors, and admins
- Row-level security in the database
- Server-only service credentials
- Temporary-password workflow for new accounts
- Forced password replacement support
- MFA requirement before privileged admin/supervisor tools
- Secret files excluded from Git
- Sensitive workbook files, exports, and backups excluded from Git

Any credentials that were copied into chat, email, screenshots, or shared notes should be rotated before production launch.

## Current live environment

The application is deployed on Cloudflare Workers and connected to Supabase.

Live application:

https://sygshift.sygilant.workers.dev

Source repository:

https://github.com/Jbro9204/SygShift

## Current quality checks

The build is being checked with:

- Type checking
- Linting
- Unit tests
- Production build tests
- Browser/e2e tests on desktop and mobile layouts
- Live Cloudflare smoke checks
- Git source scans for secrets and development-tool traces

The most recent verified runs passed before deployment.

## Remaining rollout work

Before a full company rollout, the remaining work should be treated as controlled launch preparation:

1. Rotate any exposed Supabase or deployment credentials.
2. Confirm Cloudflare Worker secrets are set correctly.
3. Confirm Supabase security advisor has no critical findings.
4. Have supervisors review the shifts marked “Review needed.”
5. Confirm every active employee who needs access has a login.
6. Test the full workflow with a small pilot group: one admin, one supervisor, and a few guards.
7. Confirm payroll export format matches the company’s payroll process.
8. Train supervisors on schedule edits, call-offs, announcements, and review-needed items.
9. Train guards on logging in, viewing schedules, requesting openings, requesting time off, and using the time clock.

## Realistic timeframe

If credentials, employee confirmation, and supervisor review decisions are available promptly, the application can move from current live build to pilot-ready status quickly.

A realistic rollout path is:

- 1 to 2 days for final security checks, credential rotation, and configuration verification
- 1 to 3 days for supervisor review of ambiguous workbook schedule items, depending on how many require business judgment
- 1 day for pilot testing and small fixes found during real use
- 1 day for employee handoff/training materials and login distribution

That puts a careful pilot rollout in the range of several business days, assuming decision-makers are available and no major workbook-data surprises appear.

## Plain-English summary

SygShift turns the existing schedule workbook into a secure, readable, usable operations system. It keeps the company’s current scheduling logic, but makes it easier for real people to use. It also adds guardrails so the system does not quietly make risky assumptions with employee assignments, armed qualifications, timekeeping, or payroll-related information.
