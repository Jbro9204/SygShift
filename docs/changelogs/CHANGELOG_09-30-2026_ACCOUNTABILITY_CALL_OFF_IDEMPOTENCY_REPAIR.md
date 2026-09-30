# Accountability Call-Off Idempotency Repair

Date: 09/30/2026
Status: Released to production

## Outcome

Accountability call-offs now follow the scheduled occurrence instead of the
temporary shift UUID created by each schedule publication. An employee,
Dispatcher, or manager can safely retry the same call-off from the current or
immediately superseded schedule without creating a second visible occurrence,
a second coverage workflow, or a second Dispatch notification.

The supplied 09/29/2026 Market call-off is repaired in production. The
Accountability Tracker now shows one Joel Kakule occurrence with the original
employee note, and its Review dialog shows **Coverage plan completed**. The
later duplicate event and call-off report remain retained and linked as audit
history rather than being deleted.

## Root cause

Schedule publication gives the same logical shift a new database UUID. The
Accountability and call-off creation paths used the submitted shift UUID as
their duplicate identity, so a stale form and a current schedule could record
the same employee absence twice. The employee self-report path also lacked a
durable coverage handoff, and a terminal coverage result could leave its
operational alert active.

## Repair

- Resolves an submitted shift to the one unambiguous, current published
  assignment for the same employee and scheduled occurrence. Removed,
  reassigned, time-edited, draft, archived, and ambiguous shifts are rejected.
- Serializes logical-occurrence creation and returns the canonical event and
  call-off report on exact or schedule-revision retries.
- Routes employee self-reporting, manager Accountability entry, Time
  Operations entry, and the legacy employee call-off RPC through the same
  idempotent behavior.
- Preserves original factual notes, assignments, punches, reports, coverage
  decisions, payroll data, and history. Existing duplicate rows are linked to
  their canonical records; none are deleted.
- Gives an employee self-report a durable coverage handoff and operational
  alert so Operations can act without re-entering the occurrence.
- Closes the operational alert when coverage is resolved or canceled and
  repairs the supplied stale completed alert.
- Filters linked duplicates from Accountability, Time Operations, Request
  Center, payroll/accountability reporting, HR short-notice reporting, and the
  Workforce Activity report.
- Shows **Continue coverage** for an unresolved existing handoff and
  **Coverage plan completed** for a terminal decision.
- Suppresses a Dispatch email retry only after successful delivery was
  recorded. A prior failed delivery can retry through the audited email path.

## Files and database change

- Application contracts and UI:
  - `src/data/accountability.ts`
  - `src/data/timekeeping.ts`
  - `src/time/AccountabilityPage.tsx`
  - `worker/index.ts`
- Regression coverage:
  - `src/accountabilityCalloffIdempotencyGuard.test.ts`
  - `src/data/accountability.test.ts`
  - `src/time/AccountabilityAbsenceCoverage.test.tsx`
  - `supabase/tests/accountability_calloff_idempotency_regression.sql`
- Forward migration:
  - `supabase/migrations/20260930133740_accountability_calloff_idempotency_repair.sql`

## Verification

- The migration and SQL regression first ran together inside one production
  `BEGIN ... ROLLBACK` transaction. The rehearsal passed after catching and
  correcting a row-variable compile error; verification found no retained
  schema columns or fixture rows.
- The checked-in SQL regression passed again after installation and rolled
  back its synthetic stale/current schedule pair. It proves employee,
  manager, Time Operations, and legacy retries reuse one canonical event,
  report, action, alert, and coverage handoff while retaining the original
  note and assignment.
- Focused application regression: **7 files / 49 tests passed**.
- Full `pnpm check`: strict TypeScript, zero-warning application/Worker lint,
  **339 test files / 1,797 tests**, production builds, and the static-asset
  contract all passed.
- Mandatory actual-component Time Clock matrix: **42/42 passed** across
  desktop Chromium and Pixel 7 mobile Chromium after the final Worker change.
- Production postflight confirmed the supplied history has one canonical
  event and one canonical coverage-bearing call-off, with linked retained
  duplicates, completed `no_replacement` coverage, and the operational alert
  inactive with lifecycle state `resolved`.
- Before/after counts were unchanged for attendance events, call-off reports,
  call-off actions, coverage cases, operational alerts, shift assignments,
  time events, and locked payroll export rows/batches. No fixture rows remain.
- Private canonicalization helpers are not executable by `authenticated`;
  employee and authorized manager RPCs remain available. New self-foreign-key
  indexes and every affected duplicate filter are present.
- Supabase security and performance advisors reported no finding tied to the
  new duplicate links, indexes, or private helpers. Existing project-wide
  advisories remain separate work.
- Authenticated live verification at `/time/accountability` showed exactly one
  supplied 09/29 Joel occurrence and the Review dialog showed **Coverage plan
  completed** with the original factual note.
- Both production origins returned healthy and ready with every required
  binding available, and both served the exact local production asset hashes.

## Production release references

- Implementation commit: `681f585bf814562c7eed8df2723efef440589127`
- Production migration ledger: `20260930144337`
- Cloudflare Worker version: `49d767db-7af0-4f64-bd04-9403525ed35e`
- Rollback tag:
  `rollback/pre-accountability-calloff-idempotency-repair-20260930`
- Rollback tag target: `85e5a14e6309744e22ab5fb21674667d0b50f2bf`
- Production origins:
  - `https://app.sygilant.us`
  - `https://sygshift.sygilant.workers.dev`

The rollback tag restores application source only. Database behavior is
forward-only and must be corrected with a new migration if another change is
ever needed.

## Known narrow limitations

- Legacy direct Data API inserts into `call_off_reports` are retained for
  compatibility and can bypass logical-occurrence deduplication; all current
  application paths use the repaired RPCs.
- Two truly simultaneous direct email retries before the delivery flag is
  persisted could race. The normal UI prevents rapid duplicate submission,
  and later retries suppress already-recorded delivery.
- Reclassification reuses the canonical call-off report but does not link a
  newly reclassified attendance event as a duplicate when another canonical
  absence event already exists. This does not affect the repaired creation and
  retry paths.
