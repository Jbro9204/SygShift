# SygShift My Account Release

**Release date:** 08/27/2026

**Area:** Employee self-service, account security, profile information, and notifications

## Summary

SygShift now provides one organized My Account workspace for every signed-in employee. The workspace keeps personal profile updates, employment information, account security, and email preferences together without mixing employee self-service with administrator-only User Accounts controls.

## What changed

### Profile & Contact

- Employees can update their preferred name, personal email address, and mobile phone number.
- Company email remains visible but read-only.
- Personal email changes use a verification workflow before the new address is confirmed.
- Profile photos can be added, replaced, or removed independently from other profile changes.
- Photo uploads accept JPEG and PNG images up to 5 MB and are stored in private object storage.
- The header identity image refreshes immediately after a successful photo change.

### Employment

- Employees can review their legal name, username, employee number, title, role, employment type, employment status, and company email.
- Employment and access-control information remains read-only in My Account and continues to be managed through the appropriate administrative workspaces.

### Security

- Password changes, authenticator management, trusted devices, recovery codes, session controls, and security activity now live together in a focused Security tab.
- The existing protected `/account-security` checkpoint remains in place for first-login password and MFA completion.
- Sensitive actions use confirmation, server-side authorization, immediate feedback, and audit records.
- Employees can revoke remembered devices and sign out other sessions without exposing administrator account controls.

### Notifications

- Employees can manage supported email preferences for published schedules, schedule changes, time-off decisions, open shifts, and general announcements.
- Required operational alerts, including call-off notifications, remain mandatory and are not disabled by optional preferences.
- Notification filtering is enforced in the server delivery path rather than only in the interface.

## Security and data safeguards

- Private contact, verification, preference, and photo records remain outside normal public table access.
- Profile-photo objects are stored in a private bucket with MIME-type and file-size restrictions.
- Verification tokens are stored as hashes and expire.
- Employee identity is taken from the authenticated session; employees cannot use these workflows to update another employee.
- Password, device, session, and profile changes create audit history.
- Employee-controlled fields are deliberately separated from legal name, company email, employment, role, permission, and credential records.

## Database release

Targeted production migration applied:

`20260827110000_my_account_self_service.sql`

Remote verification confirmed:

- My Account retrieval and profile update functions
- Notification-preference update and delivery-filter functions
- Security-action audit function
- Personal-email verification data support
- Private 5 MB employee-photo storage bucket

The migration was applied as targeted SQL because the repository retains a documented historical difference from the remote Supabase migration ledger. No migration-history repair was performed.

## Quality verification

- Type checking passed.
- Linting passed.
- All 87 test files and 442 automated tests passed.
- Access-control inventory passed.
- Production build passed.
- Source formatting and whitespace checks passed.
- Changed source and release files were checked for prohibited generator attribution.

## Employee workflow

1. Open **My Account** from the signed-in identity area.
2. Use **Profile & Contact** for personal contact details and profile photo.
3. Use **Employment** to review company-managed work information.
4. Use **Security** for password, authenticator, devices, sessions, and recovery codes.
5. Use **Notifications** to control optional email categories.

## Administrative boundary

My Account is for an employee's own information. Administrators continue to use User Accounts, Roles & Permissions, Directory, and Licensing Center for organization-managed identity, employment, access, and credential work.
