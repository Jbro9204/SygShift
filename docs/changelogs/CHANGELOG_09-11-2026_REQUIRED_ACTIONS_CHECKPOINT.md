# Mandatory Required Actions Checkpoint — Controlled Canary

Date: 2026-09-11  
Scope: One post-login queue for current confirmations, acknowledgments, attestations, HR tasks, assigned documents, and signatures

## Outcome

SygShift now has one guided Required Actions Checkpoint after password and MFA. The checkpoint is derived from the existing authoritative action records instead of copying tasks or relying on a dismissible browser flag. It is released as a reversible owner-only canary; no other employee is enrolled by this migration.

## Delivered

- Combined pending announcements, training, current schedule revisions, assigned HR workflow tasks, assigned HR documents, and signature-envelope actions into one priority-ordered queue.
- Added action-specific language for confirmation, acknowledgment, attestation, completion, and legal signature. Acknowledgment explicitly means receipt and review rather than agreement.
- Added a guided **Action 1 of N** interface with clear progress, due information, exact source version, one primary next step, and an expandable queue.
- Kept clock in/out, sick/call-off reporting, account-security recovery, and emergency guidance reachable at all times.
- Enforced the restriction in navigation, effective database permissions, and unsafe Worker mutations. Direct routes, refresh, or direct API calls cannot become a bypass.
- Kept the independently validated signature workflow separate from ordinary acknowledgment.
- Added a compact permission-scoped pending/overdue report to Action Center History.
- Added automatic refresh after an action completes and a ten-second/focus refresh for changes made from another device.
- Excluded old schedule review windows from the blocking queue while preserving every old row as historical evidence.
- Added responsive light/dark layouts, keyboard behavior, screen-reader labels, full-size touch targets, and network-retry guidance.

## Safety and release controls

- The release defaults to `canary` and initially enrolls only active employee username `jbrown`.
- Enrollment and the global gate are private service-role records and can be disabled without deleting action history.
- The migration includes a pre/post preservation assertion for employees, every source action table, role assignments, and permission overrides.
- The Worker allows only the exact pending-action completion paths plus account security, clock/call-off, and emergency access while the checkpoint is active.
- No employee, action, schedule, document, signature, role, override, or historical audit row is inserted, changed, or deleted by the release.

## Verification

- Remote PostgreSQL transactional migration and preservation assertion: passed.
- TypeScript typecheck and lint: passed.
- Required-actions unit/guard suite: 17 tests passed.
- Desktop and mobile checkpoint browser/accessibility checks: two passed.
- Full `pnpm check`: 243 files and 1,247 tests passed, followed by a clean production build.
- Rollback reference: `rollback/pre-required-actions-checkpoint-20260911`.

## Files

- `supabase/migrations/20260912120000_mandatory_required_actions_checkpoint.sql`
- `worker/index.ts`
- `src/data/actionCenter.ts`
- `src/components/AppShell.tsx`
- `src/components/RequiredActionsCheckpointNotice.tsx`
- `src/pages/ActionCenterPage.tsx`
- `src/pages/MyDocumentsPage.tsx`
- `src/App.css`
