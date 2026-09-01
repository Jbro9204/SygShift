# Human Resources Access Role

Date: 09/01/2026

## Purpose

Human Resources is a protected, MFA-required access role for the employee lifecycle. It is separate from Admin, Operations Manager, Supervisor, Recruiting & Licensing, and Finance authority.

The role is additive. Assigning it does not rewrite an employee's primary job classification, activate a dormant HR module, remove existing access, or automatically place anyone into the role.

## Included authority

- HR People and employee-file management, including restricted contact fields
- Recruiting, candidate approval, onboarding, and onboarding approval
- Ordinary HR document management plus disciplinary and legal/safety document families
- Leave and benefits administration without protected medical-leave details
- Talent, performance, learning, training, employee relations, non-medical safety, and assets
- Offboarding, employee self-service administration, HR automation operations, and HR reporting
- Directory and credential maintenance, licensing management, approved employee communications, and operational time-off decisions
- User Accounts visibility, approved welcome/login communications, and audited employee password-reset assistance
- Schedule and team-time visibility for HR review without schedule editing, punch editing, payroll export, or payroll reassignment

## Explicit exclusions

- Roles, permissions, individual overrides, security administration, MFA/security-key administration, login disable/enable, separation/deletion, and Admin-account authority
- System Operations, maintenance controls, deployment controls, database access, and secrets
- Compensation, total rewards, payroll integration, payroll exports, payroll reassignment, salary, banking, tax, SSN, and financial vaults
- Identity-document, medical-document, protected-leave, and restricted-medical-safety vaults
- Schedule publication, schedule editing, punch correction, time maintenance, patrol, sites/posts, and operational command authority
- Licensing-rule configuration and HR automation override

## Highly restricted information

The base Human Resources role intentionally does not open identity, medical, financial, compensation, protected-leave, payroll-integration, or restricted-medical-safety data. If policy later requires access, grant only the exact permission to a named employee with a documented reason, recent MFA, approved retention rules, and an audit review. Do not broaden the base role for convenience.

## Assignment rule

Assign Human Resources through **Roles & Permissions > Employee access** only after the employee completes MFA and their HR responsibilities are approved. Dormant HR modules remain unavailable until their independent database and Worker release gates complete controlled activation.

## Recovery boundary

Removing the additional Human Resources membership removes the HR bundle without changing the employee's base role, employee record, onboarding history, document history, schedule, time, payroll, or audit history.

