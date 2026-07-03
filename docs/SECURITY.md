# Security baseline

## Access

- Accounts are invite-only.
- Privileged roles require multi-factor authentication before sensitive mutations.
- Disabled or separated employees cannot authenticate or accept work.
- Authorization is enforced in the database and server, never only in the interface.
- Administrative changes require a current authenticated account and are audited.

## Data handling

- Service-role and secret keys are forbidden in browser configuration.
- Sensitive site details are stored separately from ordinary site records.
- Sensitive site details are never included in announcement or email bodies.
- Access to sensitive site details is limited to Admins, Supervisors, and guards actively assigned to that location, and access is logged.
- Workbook source files and extracted private data are excluded from Git.
- Logs must not contain credentials, full request bodies, private contact information, or site secrets.

## Workforce rules

- Armed posts require a current armed qualification. The rule applies to visibility, requests, approvals, and direct assignment.
- Schedule publication and payroll locking are privileged actions.
- Timeclock events use server time. Client timestamps may be recorded only as diagnostic metadata.
- Original punches cannot be edited or deleted; corrections are separate amendments with actor, reason, and time.
- Username reservations are never reused.

## Production checks

- Review all row-level security policies with Guard, Supervisor, Admin, disabled, and unauthenticated test accounts.
- Enable leaked-password protection, rate limits, bot protection, and custom SMTP in Supabase.
- Require MFA for Supervisors and Admins.
- Configure restrictive Cloudflare security headers and rate limits.
- Run dependency, secret, static-analysis, accessibility, and end-to-end checks before release.
- Test restoration from database backup before launch and on a recurring schedule.
