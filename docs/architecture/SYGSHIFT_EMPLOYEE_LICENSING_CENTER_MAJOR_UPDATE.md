# SygShift Licensing Center — Employee Self-Service Major Update

Date: 09/24/2026  
Status: Released to production  
System: Existing SygShift Licensing Center

## Product decision

This work is a major update to the existing Licensing Center. It does not create
a second licensing product, a parallel credential database, or an employee-only
record system. Employees, the Licensing Coordinator, HR, and authorized
administrators use one controlled lifecycle around the existing canonical
`employee_credentials` record.

The employee supplies evidence. An authorized reviewer determines whether that
evidence changes the verified company record.

## Employee experience

Every authenticated employee receives a **My Licenses & Credentials** workspace
inside the existing Licensing Center. The workspace provides:

- the credentials currently associated with the employee;
- status, credential number, issuing authority, issue date, expiration date,
  document count, and clear renewal instructions;
- a secure path to submit a new credential, renewal, correction, or proof that
  a renewal is in progress;
- multi-file PDF, PNG, JPEG, and WebP uploads, up to 25 MB per file;
- drafts that can be resumed;
- removal of an incorrect attachment while a draft or requested correction is
  still editable;
- an explicit Pending Review state after submission;
- correction instructions, rejection reasons, and approval outcomes;
- a complete, readable submission history; and
- protected preview and download of the employee's own documents.

Employees cannot approve their own uploads or directly rewrite an approved
credential. A correction or replacement must go back through review.

## Licensing and HR experience

The current management Licensing Center remains the system of record. It gains
an **Employee Submissions** queue with:

- awaiting-review, correction-requested, approved, and rejected views;
- search by employee, employee number, username, credential, or linked
  notification;
- employee message, dates, credential information, and protected supporting
  documents in the review workspace;
- Approve, Request correction, and Reject decisions;
- a required explanation for corrections or rejections;
- automatic promotion into the existing verified credential record after
  approval; and
- immediate recalculation through the existing compliance and eligibility
  logic.

Current coordinator functions—manual entry, correction, override, internal
notes, credential removal and restore, communication, reports, filters, and
compliance monitoring—remain intact.

## Canonical data lifecycle

1. An employee creates a draft submission.
2. Supporting files pass through the existing protected Licensing document
   pipeline with file-content validation, checksum, idempotency, and private
   storage.
3. Sending the submission changes it to Pending Review and notifies only
   authorized reviewers.
4. Approval inserts or updates the existing canonical employee credential.
5. The previous credential state and the approved state are recorded as
   immutable credential versions.
6. Supporting documents remain linked to both their originating submission and
   the canonical credential.
7. Correction and rejection decisions notify the employee with an actionable
   link and an explanation.

Proof that a renewal is underway does not extend an expired credential or make
an employee eligible. When approved, it marks the existing renewal as awaiting
the issuing authority; the current credential dates remain authoritative until
the renewed credential is approved.

## Status model

Verified credential status continues to be calculated by the existing
Licensing Center. Employee submission status is intentionally separate:

- Draft
- Awaiting Review
- Correction Required
- Approved
- Rejected
- Withdrawn

This separation prevents an unverified employee upload from being mistaken for
a company-approved license.

## Permissions and safeguards

- Employees may read and submit only their own Licensing information.
- Ownership is enforced by database functions and Worker endpoints, not only
  hidden controls.
- New submission tables use forced row-level security and do not grant direct
  authenticated table access.
- Management review requires an effective Licensing management or credential
  editing permission and MFA.
- Cross-employee document access requires management permission and recent
  protected-document MFA.
- An employee may view their own document without being granted broad Licensing
  management access.
- Storage object paths remain server-only.
- All uploads, previews, downloads, submissions, decisions, removals, and
  promotions are audited.
- Previous credential versions and reviewed evidence are retained.
- Anonymous access and browser access to service-only storage functions are
  denied.

## Credential catalog

The update continues to use the editable credential-type catalog. It also adds
standard catalog entries for plainclothes endorsements, concealed handgun
permits, AED certifications, and external training certificates. Existing guard
licenses, armed credentials, driver licenses, First Aid/CPR records, site
training, and custom credential types remain supported.

Internal SygShift training completion remains authoritative in the Training
area; an external training certificate in Licensing is supporting qualification
evidence, not a duplicate training-completion record.

## Responsive and accessibility standard

The employee and reviewer workspaces use the established SygShift cream, black,
and gold system with consistent typography, spacing, rounded controls, status
language, and button hierarchy. Workflows stack without horizontal scrolling on
phones, small laptops, and high browser zoom. Every important action has a text
label, visible status, loading state, error state, and retry path.

## Existing automation retained

The established 90-, 60-, and 30-day credential warnings remain in place. This
update adds workflow notifications for employee submissions, reviewer work,
correction requests, approvals, and rejections without removing the existing
expiration process.

## Acceptance criteria

- A Guard with no management permission can open Licensing and see only their
  own information.
- The Guard can save a draft, attach multiple supported files, submit, and see
  Awaiting Review.
- A different employee cannot read or modify that submission.
- An authorized reviewer with MFA can review it from the management queue.
- Approval updates the existing credential, links its documents, records a
  version, resolves reviewer work, and notifies the employee.
- Correction Required leaves the verified credential unchanged and gives the
  employee an editable, actionable request.
- Rejected and withdrawn submissions do not alter the verified record.
- Employee access does not expose internal notes, unrelated employee data, or
  server storage paths.
- Current management Licensing functions, reports, expiration alerts, schedule
  eligibility, timekeeping, and unrelated modules continue to work.

## Release record

All acceptance criteria above were implemented and released on 09/24/2026.
The complete database, authorization, responsive-design, regression, deployment,
and production verification record is maintained in
`docs/changelogs/CHANGELOG_09-24-2026_EMPLOYEE_LICENSING_CENTER_MAJOR_UPDATE.md`.
