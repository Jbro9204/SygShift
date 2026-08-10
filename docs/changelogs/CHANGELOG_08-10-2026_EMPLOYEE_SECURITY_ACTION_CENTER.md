# SygShift Change Log — 08/10/2026

## Employee Security, Action Center, Training, Schedule Acknowledgments, and Work Classification

### Production release

- Production application: https://app.sygilant.us
- Cloudflare Worker version: `050d07dc-4f1d-47dc-b637-96115954cfb3`
- Production health check: passed with HTTP 200
- Database project: SygShift Supabase production project

### Account security

- Improved mobile authenticator enrollment with a responsive setup flow.
- Added QR enrollment, manual setup-key access, authenticator-app handoff, verification, and clearer first-time instructions.
- Added one-time MFA recovery codes with secure hashing, controlled replacement, controlled revocation, and service-only consumption.
- Preserved the existing administrator MFA reset workflow and audit trail.

### Employee Action Center

- Added a dedicated Action Center for all active employee roles.
- Added required announcement review and acknowledgment.
- Added assigned training review, completion attestation, and completion tracking.
- Added published-schedule acknowledgment tied to the employee's exact published shift snapshot and schedule revision.
- New or changed published shifts create a new acknowledgment requirement only for affected employees.
- Preserved the existing manual schedule-notification workflow.

### Announcements

- Added optional required acknowledgment and due dates to approved announcement publishing.
- Required announcements retain immutable title and message snapshots for each employee acknowledgment.
- Revised required announcements supersede incomplete acknowledgments without changing completed historical records.
- Added acknowledgment status reporting for authorized users.

### Training

- Added versioned training records for written instructions, documents, videos, and external links.
- Added audience assignment by employee, role, scheduled site, and employee state.
- Added employee completion attestation and effective/due dates.
- Added authorized completion reporting and CSV export.
- Historical assignments remain tied to the exact training version assigned.

### Credential tracking

- Added California Baton Permit as a sensitive credential type.
- Permit records are auditable and can be included in training assignment targeting.
- The permit does not independently mark an employee legally eligible for a shift; eligibility remains an administrative decision based on the complete credential record.

### Timekeeping and payroll

- Added explicit `Post Time` and `Training Time` work classifications throughout punches, corrections, exceptions, attendance, payroll review, and payroll exports.
- Both classifications remain paid and overtime-eligible.
- Payroll summaries and workbooks display separate Post and Training totals while preserving combined worked hours.
- Added a database-level payroll export guard that rejects unclassified or mixed-classification rows.
- Added administrator confirmation for the configured Post and Training payroll treatment before an official payroll lock.
- Existing historical punches default safely to Post Time for backward compatibility.

### Roles, permissions, and auditing

- Added configurable permissions for employee actions, announcement acknowledgment management, training management/export, and schedule acknowledgment management.
- All employee roles can access their own assigned actions.
- Sensitive management and export actions require both the relevant permission and an MFA-verified session.
- New security, acknowledgment, training, and work-classification changes write to the existing audit system.

### Database changes

Applied and verified in production:

- `20260810180000_employee_action_center.sql`
- `20260810181000_training_and_post_time.sql`
- `20260810182000_mfa_recovery_codes.sql`
- `20260810183000_payroll_work_type_hard_guard.sql`

### Verification completed

- TypeScript type check: passed
- ESLint: passed
- Automated tests: 40 files, 191 tests passed
- Production build: passed
- Desktop and mobile browser tests: 18 of 18 passed
- Cloudflare deployment startup validation: passed
- Production health endpoint: passed
- Git whitespace validation: passed
- Production browser console: no warnings or errors during the verified login and redirect checks

### Administrative configuration note

Before the next official payroll lock, an administrator must confirm the company's intended pay-code and base-rate treatment for Post Time and Training Time. SygShift intentionally does not guess this payroll policy. Both categories are currently included as paid, overtime-eligible worked time and are reported separately.
