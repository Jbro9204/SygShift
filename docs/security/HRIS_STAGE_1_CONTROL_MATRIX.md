# HRIS Stage 1 Control Matrix

**Assessment date:** 08/29/2026

| Control | Existing evidence | HRIS requirement | Stage 1 status |
| --- | --- | --- | --- |
| Permanent employee identity | `public.employees`; private account link | One identity; no duplicate HR directory | Defined and gated |
| Effective permissions | Role memberships, catalog, person grants/denies, preservation scripts | Module/row/field/action/vault checks | Contract defined; module permissions not deployed |
| Deny by default | Route policy, Worker checks, PostgreSQL RLS/functions | Unknown HR action denied at Worker and database | Required by machine guard |
| MFA | AAL2, trusted devices, security keys, recovery | Recent MFA within 15 minutes for protected HR actions | Contract defined; HR ceremony not deployed |
| Break glass | System Admin recovery paths exist | Temporary, scoped, reasoned, reviewed, audited | Design complete; workflow not deployed |
| Append-only audit | `private.audit_events`; append-only operational histories | Audit protected views, exports, approvals, documents, emergency access | Existing foundation verified; HR events pending |
| Private storage | Existing private domain buckets | Six separately permissioned HR vaults | Reserved only; not deployed |
| Document safety | Type/size restrictions on existing buckets | Signature validation, quarantine, malware scan, versioning, legal hold | Required release blocker |
| Maintenance | Feature-scoped, MFA, automatic expiration, audit, recovery | New HR modules disabled independently and protected during release | Existing control verified |
| Background jobs | Every-minute bounded time/alert/notification automation | Independent idempotent HR jobs with retry/dead-letter controls | Existing pattern verified; HR jobs pending |
| Backup and recovery | Supabase managed backups stated; release runbooks | HR schema restore drill and document recovery evidence | Required release blocker |
| Rollback | Forward-only migrations, Git checkpoints, maintenance recovery | Additive schemas, feature flags, forward repair, reconciliation | Defined; per-stage drill required |
| Pagination | Compact UI patterns and paged reports | Default 10, server maximum 100 | Required by machine guard |
| Payroll boundary | Locked append-only export batches and payroll assignment history | No HR payroll effects before Stage 10 contract | Defined and gated |
| Email privacy | Protected Worker delivery and blocked company-domain safety | Minimal HR email, no restricted contents or attachments | Existing pattern; HR templates pending |

## Non-overridable controls

The following remain hard controls even for a System Admin or break-glass user:

- passwords, service keys, private signing material, or recovery secrets cannot be exposed;
- original punch evidence and locked payroll exports cannot be rewritten;
- audit records cannot be edited or deleted;
- malware-quarantined documents cannot be previewed or downloaded;
- separated or disabled accounts cannot authenticate;
- a record cannot be assigned to a nonexistent employee identity;
- a legal hold cannot be silently bypassed;
- an HR feature cannot accept protected production data while its release gate is closed.

## Stage 1 acceptance gates

- Repository discovery and source-of-truth map are current.
- Classification, vault separation, authorization dimensions, recent MFA, break glass, audit, pagination, and payroll boundaries are documented.
- `pnpm check:hris-foundation` passes.
- The HRIS foundation guard test passes.
- The feature/program gate remains disabled and protected production HR data remains prohibited.
- Backup/restore and document-quarantine evidence remain explicit blockers for the stages that introduce schema or files.
