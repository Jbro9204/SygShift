# HRIS Data Classification and Access Baseline

**Approved baseline:** 08/29/2026

## Security objective

HRIS access is denied unless the signed-in employee has the exact effective permission, is within the permitted record scope, satisfies field and action restrictions, and has recent MFA when required. A visible page, role title, manager relationship, or returned record ID is not authorization.

## Data classes

| Class | Examples | Baseline controls |
| --- | --- | --- |
| Internal | Department, position title, work location | Authenticated access; permission-aware lists; no public indexing |
| Confidential | Contact data, employment history, manager notes | Exact module permission; row scope; audited protected changes |
| Restricted | Compensation, benefits, disciplinary records, HR cases, performance | Separate sensitive permission; recent MFA for reads with material exposure and all mutations/exports; protected audit |
| Highly restricted | Government ID, banking, medical, background check, legal/safety documents | Dedicated vault permission; recent MFA; server-only delivery; short-lived access; audit every preview/download/export; no email disclosure |

## Authorization dimensions

Every HR service must evaluate all applicable dimensions:

1. **Module:** may the actor enter this HR workspace?
2. **Row:** may the actor access this employee, candidate, case, or document?
3. **Field:** may the actor see or change this confidential field?
4. **Action:** may the actor perform this exact operation?
5. **Vault:** may the actor access this document category?
6. **State:** is the record in a state that permits the action?
7. **Session:** is the account active and is recent MFA satisfied?
8. **Purpose:** does the action require an audit reason, approval, or second-person review?

Failure at any dimension denies the request with a safe message and a request ID. The system must not return restricted data and then hide it with CSS.

## Permission design

Each module receives independent `view`, `manage`, and `restricted` permissions. Vault categories receive separate read and write permissions. Role templates may bundle permissions, but the effective-permission engine remains authoritative and person-specific grants or denies remain supported.

Initial HR permissions must not be automatically added to existing roles during a schema migration. Stage releases require an explicit, reviewed role-mapping change with before/after production access evidence and a tested System Admin recovery path.

## Recent MFA

- Protected writes, approvals, exports, compensation actions, case actions, identity/financial/medical document access, and break-glass access require recent MFA.
- The target freshness window is 15 minutes and must be checked server-side.
- Remembered-device status may satisfy ordinary protected workspace access but does not automatically satisfy a recent-MFA ceremony.
- Security-key verification may satisfy recent MFA when its server session is valid and the action policy allows it.
- Reauthentication never discards unsaved work without a warning and recovery path.

## Document vault boundary

The future vaults are general HR, financial, identity, medical, disciplinary, and legal/safety. Every object remains private and is addressed through a database document ID—not a user-provided storage path.

Before an object becomes available it must pass:

1. extension, MIME, size, and file-signature validation;
2. active-content restrictions;
3. quarantine storage;
4. malware scanning;
5. an authorized release from quarantine;
6. version and retention registration.

Preview and download use short-lived, single-purpose server delivery after an authorization check. Public URLs and permanent signed URLs are prohibited. Every preview, download, replacement, archive, restore, retention change, and legal hold is audited.

## Break-glass access

Break-glass access is disabled by default and is not a hidden Admin bypass. The future workflow must:

- require a designated emergency permission and recent MFA;
- require a specific incident and explanation;
- identify the employee/vault/module scope;
- expire within 60 minutes;
- prevent the requester from approving their own use;
- create append-only start, access, and end events;
- notify the designated reviewer without including protected data;
- require second-person review after use;
- permit immediate revocation.

Break-glass cannot bypass impossible-data rules, locked payroll snapshots, audit integrity, malware quarantine, or separated-account authentication controls.

## Audit requirements

Audit records include actor, subject, action, record identity, request ID, timestamp, purpose/reason, result, relevant before/after values, session assurance, and originating service. Secrets, passwords, full government identifiers, document contents, and medical narratives are never copied into an audit payload.

Protected reads and exports are auditable even when they do not mutate a record. Audit history is append-only and accessible only through a dedicated permission-safe service.

## Session and service controls

- Accounts must be active and tied to an active employee unless an approved preboarding flow explicitly permits limited candidate access.
- Worker service credentials stay in protected Cloudflare bindings.
- Browser storage cannot contain document access tokens, restricted exports, or long-lived emergency grants.
- List endpoints use server pagination with a default of 10 and maximum of 100.
- Search input is validated and result fields are permission-filtered before delivery.
- Background jobs use bounded batches, idempotency keys, retries, failure records, and operator-visible recovery.

## Current release status

The classification and authorization contract is approved and machine validated. Future permissions, vaults, and services are not yet deployed. `protectedProductionDataAllowed` remains `false`, and all HRIS feature flags remain logically off until their release evidence exists.
