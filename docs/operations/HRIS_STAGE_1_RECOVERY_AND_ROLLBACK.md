# HRIS Stage 1 Recovery and Rollback

**Issued:** 08/29/2026

## Stage 1 operating state

Stage 1 adds repository documentation, a security-boundary contract, validation tooling, and a test. It does not create HR tables, buckets, permissions, records, routes, or production UI. All future HRIS features are considered disabled, and protected production HR data is prohibited.

## Release controls for every later stage

1. Capture the Git commit and Cloudflare version currently serving production.
2. Capture schema migration state and a permission-assignment baseline.
3. Confirm the relevant HRIS feature flag is off.
4. Confirm a current database backup exists under the approved Supabase plan.
5. For document stages, confirm object-version backup and restore procedures before upload is enabled.
6. Apply additive migrations only.
7. Run migration verification, RLS tests, permission-boundary tests, audit tests, and reconciliation.
8. Deploy the application with the feature still off.
9. Validate production health, admin recovery, ordinary-user denial, mobile layout, and rollback.
10. Enable the smallest approved audience through a controlled feature flag.

## Database recovery model

Production migrations are forward-only. Do not rewrite migration history or use destructive reset commands. If an additive schema change must be backed out:

- disable the affected HRIS feature;
- restore the prior application version;
- preserve new tables and columns until all callers are removed and data is reconciled;
- apply a reviewed forward-repair migration where needed;
- use point-in-time or backup restoration only under an incident plan that accounts for changes made after the restore point.

A restoration drill must be completed in an isolated environment before the stage introducing protected HR records is activated. The evidence must record the backup timestamp, restore target, schema/object counts, checksums where appropriate, permission results, duration, operator, reviewer, and cleanup confirmation.

## Document recovery model

Before Stage 4 activation, verify:

- quarantined and released objects restore with their metadata;
- object versions remain linked to the correct employee and document identity;
- retention dates and legal holds survive recovery;
- restored objects remain private;
- malware/scan disposition does not revert to trusted without evidence;
- preview/download audit history still references the immutable document version;
- deleted or archived objects follow approved retention rather than permanent browser deletion.

## Emergency containment

If an HR release exposes data or grants excess access:

1. Activate feature-specific read-only or blocked maintenance for the affected HR feature.
2. Disable its feature flag.
3. Revoke affected short-lived sessions and emergency grants.
4. Preserve logs, audit records, request IDs, and deployment versions.
5. Restore the last verified application version.
6. Run access-preservation and direct-object-access tests.
7. Notify the designated incident owner without including protected record contents.
8. Reopen only after root-cause correction, peer review, and documented production verification.

Clock-in/out, Schedule, Time & Attendance, User Accounts, Licensing, and Payroll remain operational unless the incident specifically affects them. Do not disable unrelated workflows.

## Break-glass recovery

Break-glass workflow implementation is reserved for a later protected migration. Until it exists and passes tests, normal System Admin recovery controls remain the only recovery path and do not grant access to nonexistent HR vaults. The future break-glass path must be scoped, recent-MFA protected, time-limited, independently reviewed, and append-only audited.

## Stage 1 rollback

Because Stage 1 has no runtime or database change, rollback consists of reverting its repository commit. No production deployment or data rollback is required. The safer state is to retain the contract because it keeps protected HR data blocked.
