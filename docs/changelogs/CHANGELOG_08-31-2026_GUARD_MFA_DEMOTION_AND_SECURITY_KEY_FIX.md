# SygShift Change Log — Guard MFA Demotion and Security-Key Display Repair

**Date:** 08/31/2026  
**Area:** User Accounts / Login & Security

## Completed

- Verified that the system Guard role does not require MFA. An employee whose primary role is changed to Guard is no longer sent through authenticator enrollment unless a separate protected role or individual protected permission is intentionally still assigned.
- Preserved the one-time permanent-password setup for accounts that still have a temporary password. This is password setup, not MFA.
- Corrected the administrator security-key API response so the Login & Security tab receives the employee name, employee ID, key list, and request ID it requires.
- Replaced raw validation output with a concise operational message if a malformed security-key response is ever received again.
- Added regression coverage for the complete security-key response contract and the Guard role's password-only MFA baseline.

## User impact

- Randall Hurst's Guard role follows the standard username/password path and does not require authenticator setup from the Guard role.
- The Physical Security Keys section no longer displays the raw `displayName` / `employeeId` validation error shown in User Accounts.
