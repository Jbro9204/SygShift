# Operations Manager Access Role

Date: 09/01/2026

## Purpose

Operations Manager is a protected, MFA-required access role for companywide operational leadership. It sits above the Supervisor operational bundle without becoming a substitute for Admin, HR, Finance, or security administration.

The role is additive. Assigning it does not rewrite an employee's primary job classification, remove existing access, or automatically place anyone into the role.

## Included authority

- Companywide schedule, scheduler, shift-pool, coverage, availability, events, and site/post management
- Team attendance, time correction, manual-entry, adjustment-review, and operational exception resolution
- Patrol, accountability, notifications, announcement, acknowledgment, and operational reporting controls
- Employee directory and credential maintenance
- Licensing review, management, and approved communications without licensing-rule configuration
- Training management and export
- Basic HR People and Onboarding visibility without protected HR record access
- User Accounts visibility, approved onboarding/login communications, and audited password-reset assistance

## Explicit exclusions

- Roles, permissions, individual overrides, security administration, and Admin-account authority
- MFA reset, security-key administration, remembered-device revocation, login disable/enable, and employee separation/deletion
- System Operations, maintenance controls, deployment controls, database access, and secrets
- Payroll export, locked payroll reassignment, payroll integration, compensation, salary, banking, tax, SSN, PHI, and financial vaults
- Licensing-rule configuration
- Protected HR documents, restricted employee files, medical information, employee cases, compensation, benefits, protected leave, safety, and other restricted HR modules

## Assignment rule

Assign Operations Manager through **Roles & Permissions > Employee access** only after the employee has completed MFA. The role is protected against casual permission editing. Sensitive exceptions must use a separately reviewed person-specific permission with an audit reason; they must not be folded into this role.

## Recovery boundary

Removing the additional Operations Manager membership removes the elevated bundle without changing the employee's base role, employee record, schedule history, time history, or audit history.

