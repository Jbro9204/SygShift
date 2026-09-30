# HRIS Secure Document Pipeline Rollback

## Purpose

This rollback stops new HR document uploads and access without deleting employee data, document metadata, immutable versions, access history, or private objects.

## Immediate containment

1. Remove or set `SYGSHIFT_DOCUMENT_PIPELINE_ENABLED=false` and deploy the Worker.
2. Set `private.hr_document_release_gate.enabled=false`, clearing the activation metadata through an audited administrative operation.
3. Confirm that new upload requests and new access-grant requests are denied.
4. Confirm that unused access grants cannot be consumed after the database gate closes.
5. Confirm there are no incomplete protected-storage verification attempts; retry only after the underlying storage issue is resolved.

## Preservation requirements

Do not delete records or objects as part of rollback.

- Preserve upload operations and their final state.
- Preserve immutable document versions.
- Preserve append-only access evidence and protected-storage integrity evidence.
- Preserve archive, retention, and legal-hold records.
- Preserve current employee roles, individual grants, and individual denials unless a separately approved access-removal action is required.
- Keep private objects isolated for approved disposition.

## Recovery verification

After containment:

1. Verify the application, authentication, Schedule, Time & Attendance, Payroll, User Accounts, Licensing, and existing HR People workspace remain operational.
2. Verify the Worker release flag is absent or false.
3. Verify the database release gate is false.
4. Verify a new upload is denied.
5. Verify a new access grant is denied.
6. Verify an issued but unused access token is denied.
7. Re-run `pnpm check:hris-documents`, `pnpm check:hris-document-pipeline`, and `pnpm check`.
8. Record the incident, who initiated rollback, the affected time window, and the evidence retained for follow-up.

## Re-enabling after rollback

Treat re-enablement as a new controlled release. Resolve the cause, repeat protected-storage and restore evidence, use a canary permission assignment, perform the complete activation sequence, and retain a new approval record. Never re-enable solely because the original deployment appears healthy again.
