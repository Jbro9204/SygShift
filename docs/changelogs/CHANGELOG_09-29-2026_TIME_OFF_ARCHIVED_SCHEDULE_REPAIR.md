# Time Off Archived Schedule Conflict Repair

Date: 09/29/2026
Status: Released to production

## Outcome

Time Off approval no longer treats an assignment retained on an archived
schedule revision as a current scheduling conflict. Archived schedules remain
available as history, while assignments on current draft and published
schedules continue to block approval until Operations resolves them.

## Root cause and repair

The rebuilt Time Off decision function excluded superseded schedules but did
not exclude archived schedules. A canceled or rebased draft can retain its
shift and assignment rows for audit purposes, so those historical rows could
incorrectly prevent approval indefinitely.

Forward migration
`20260929132650_time_off_archived_schedule_conflict_repair.sql` narrows the
final approval recheck to schedule status `draft` or `published`. It retains the
same employee-scoped transaction lock, permission boundary, MFA requirement,
independent-review rule, note requirement, decision snapshots, audit entry, and
notification behavior.

## Verification

- Expanded the rollback-only Time Off interval regression to prove that an
  archived assignment does not appear in the affected-current-shift snapshot
  and does not block approval.
- The same regression proves that both draft and published overlapping
  assignments still block approval and preserve the pending request.
- The Time Off interval, request-center rebuild, absence coverage completion,
  schedule DST boundary, schedule week-copy time basis, and Dispatch overlap
  regressions all passed against the linked production schema.
- Full application release gate passed **334 files / 1,765 tests** and the
  mandatory Time Clock preservation matrix passed **42/42**.
- No Time Off, schedule, assignment, timekeeping, payroll, or audit rows were
  deleted or rewritten.

## Production release references

- Source commit: `3b36035`
- Production migration ledger: `20260929132650`
- Cloudflare Worker version for the paired release:
  `33649eac-1aab-4287-a254-95cbc245c196`
- Rollback tag: `rollback/pre-salaried-shift-confirmations-20260929`
- Health and readiness returned HTTP 200 after the database and application
  release.
- Desktop archive copy:
  `C:\Users\Jordan\Desktop\SygShift Changelogs\CHANGELOG_09-29-2026_TIME_OFF_ARCHIVED_SCHEDULE_REPAIR.md`.

## Operator notes

Archived schedules are historical and should not be reactivated. If a request
still overlaps a current draft or published assignment, resolve that assignment
before approving the Time Off request. Correct future database behavior with a
new forward migration; never edit the applied repair.
