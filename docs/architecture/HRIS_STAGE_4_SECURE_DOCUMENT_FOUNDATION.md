# HRIS Stage 4 Secure Document Foundation

> **Superseded workflow notice — 09/30/2026:** This document records the original foundation design. The active document workflow has no malware scanner, quarantine queue, scanner callback, or background preparation state. A supported upload becomes available immediately after server-side file validation, private storage verification, and SHA-256 integrity verification. Private storage, access controls, recent MFA, immutable versions, retention, legal holds, short-lived access, and audit records remain required.

## Run 1 boundary

Stage 4 Run 1 installs a dormant document-security foundation. It does not expose upload, preview, download, archive, restore, acknowledgment, or signature controls. The release gate is disabled by default and cannot be enabled without recorded security and recovery evidence.

No existing employee, identity, role assignment, role permission, employee override, schedule, timekeeping, payroll, licensing, or application workflow is changed by this run.

## Vault separation

The platform defines six private storage and authorization boundaries:

- General personnel records
- Payroll, tax, and benefits
- Identity and work authorization
- Medical and protected leave
- Investigations and disciplinary
- Legal, safety, and separation

Each restricted vault has separate view and manage permissions. Receiving access to one vault does not grant access to another. No Stage 4 permissions are assigned to a role or person by this run.

## Storage and object security

- Every bucket is private.
- No authenticated-browser storage policies are installed.
- Object keys contain random identifiers instead of employee names or other personal data.
- Direct browser object access is prohibited.
- Future preview and download links must be server-authorized, short-lived, and audited.
- The maximum file size is 25 MB.

## Historical Run 1 file lifecycle

This historical run required quarantine and a scanner before release. That design is no longer active. The current upload boundary verifies file signature, detected MIME type, extension, size, active content, protected storage, and SHA-256 checksum; the document is then available immediately. No upload waits on or invokes a malware scanner.

## Authorization requirements

Document access requires an active employee account, the base document permission, and the specific vault permission. The released access boundary must also require an AAL2 MFA challenge performed within the previous 15 minutes. Trusted-device state alone will not satisfy this requirement.

The existing MFA check in the dormant schema is only an account-security prerequisite. It is not the future short-lived document-access proof. The release gate must remain disabled until the recent-MFA boundary is implemented and tested.

## History, retention, and recovery

- Document versions are immutable.
- Replacements create a new version instead of overwriting an old file.
- Historical scan and access records are append-only; new availability and access records are append-only.
- Browser hard delete is prohibited; documents are archived instead.
- Active legal holds prevent disposition.
- Retention defaults to manual review until approved policies are supplied.
- Preview and download events must be recorded before released access is delivered.

## Required evidence before Run 2 release

- Protected-storage and checksum-verification behavior
- File-signature and active-content validation tests
- Recent-MFA enforcement tests
- Cross-vault denial tests
- Immediate-availability, rejected, storage-failure, and recovery-path tests
- Short-lived access and audit tests
- Backup and restore evidence
- Confirmation that current access assignments and operational data remain unchanged
