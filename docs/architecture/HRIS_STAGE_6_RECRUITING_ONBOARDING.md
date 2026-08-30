# HRIS Stage 6 — Recruiting and Onboarding Architecture

**Architecture date:** 08/30/2026
**Production posture:** Installed and dormant

## Purpose

Stage 6 adds a protected recruiting and onboarding foundation without replacing the existing employee identity, User Accounts, Directory, Licensing Center, Training, Schedule, Time & Attendance, Payroll, document platform, or Action Center.

The release is intentionally dormant. A database gate and an independent Worker flag must both be enabled before either workspace can serve protected operational data.

## Recruiting boundary

Recruiting records are private and service-only. The foundation includes:

- versioned requisitions with approval state, staffing context, job details, target dates, and structured requirements;
- applicants and applications with source, status, stage, retention date, disposition reason, and disposition history;
- append-only application stage history;
- scheduled interviews, assigned panelists, and one evidence-based scorecard per panelist;
- versioned offers with compensation basis, approval, delivery, acceptance, decline, withdrawal, and expiration states;
- append-only recruiting events for every supported mutation;
- bounded workspace reads with stable pagination;
- separate view, manage, and approval permissions.

Every recruiting mutation is executed through a service-role boundary after the Worker verifies the authenticated employee and the exact effective permission.

## Candidate conversion boundary

Candidate conversion is a controlled bridge into the existing permanent employee identity. It does not create a second employee directory.

A conversion request requires:

1. an active application with an accepted offer;
2. a documented business reason;
3. a duplicate scan against existing employee identifiers and normalized applicant contact fields;
4. one authorized requester and a different authorized reviewer;
5. explicit approval after duplicate results are available;
6. a transaction that creates one permanent `public.employees` record and its HR identity mapping together.

The created employee begins in an onboarding state. Conversion does not create login access, assign roles, publish a schedule, create payroll time, or mark onboarding complete. Append-only conversion events preserve the request, duplicate review, decision, actor, time, and resulting employee identifier.

## Onboarding boundary

Onboarding is template-driven and effective-dated. Templates can represent state, legal entity, job, employment type, department, armed requirement, location, manager, licensing, training, equipment, badge/key, account invitation, site access, employee information, emergency contact, tax/payroll, direct deposit, I-9, acknowledgment, and document requirements.

Template steps support:

- employee, manager, HR, IT, licensing, training, and operations responsibility groups;
- required and optional work;
- due-date offsets;
- dependency graphs with cycle prevention;
- assigned owners;
- reminders, overdue notices, and escalations;
- completion, waiver, and not-applicable outcomes with reasons;
- readiness calculated from both task state and the current authoritative SygShift source system.

Licensing, Training, employee documents, account readiness, equipment, and site-access requirements are referenced; their authoritative records are not copied into onboarding.

## Security model

- All Stage 6 operational tables are in the private schema with row-level security enabled.
- Browser roles have no table access.
- Service RPCs revoke public, anonymous, and authenticated execution and grant execution only to the service role.
- Administrative routes require an active authenticated employee, MFA, the exact permission, and an enabled release boundary.
- View, manage, and approval authority are separate.
- Recruiting and onboarding gates are disabled in production.
- The Worker feature flags are disabled in production.
- No Stage 6 permission is assigned to a role or employee.
- Original employee, account, access, schedule, time, payroll, licensing, and audit records remain authoritative and unchanged.

## Activation boundary

Stage 6 must not be activated as part of an ordinary deployment. Controlled activation requires:

1. named business owners and approved permission assignments;
2. recovery and rollback evidence;
3. one test requisition and applicant in a canary scope;
4. duplicate-detection validation against production employee identities;
5. a candidate-conversion rehearsal without granting login access;
6. an onboarding template reviewed by HR, IT, Licensing, Training, Operations, and Payroll owners as applicable;
7. verification that source-system readiness links are accurate;
8. mobile, accessibility, authorization, audit, and rollback validation;
9. explicit enabling of both the database gate and Worker flag;
10. post-activation production monitoring and a documented decision to continue or roll back.

## Rollback posture

Because the release is dormant, the immediate rollback is to keep or restore both gates to disabled and remove any Stage 6 permission assignments. Schema objects are additive and retained for evidence; production records are not destroyed to roll back access. If a later active release creates recruiting or onboarding data, rollback pauses new actions while preserving all applicant, conversion, employee, task, and audit history.
