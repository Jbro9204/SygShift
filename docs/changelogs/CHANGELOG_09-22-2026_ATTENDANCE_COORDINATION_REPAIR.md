# 09/22/2026 — Attendance Coordination Repair

## What changed

- Protected Accountability and time-review database requests now use the shared identity-verification checkpoint and retry once after successful MFA. Ordinary authorization denials remain denials.
- Employee timecard details no longer substitute `0 hr` when the authoritative payroll review is still loading or unavailable. The workspace shows a loading placeholder or an explicit retryable error instead.
- Late-arrival entry now records a required expected delay in minutes, calculates the expected arrival, and creates a live Time Operations alert. A valid clock-in records the actual arrival and resolves that alert automatically.
- Call-off coverage now appears on the schedule as two recognizable records: the preserved original block marked **CALL OFF** and the linked replacement block marked **COVERAGE**. The absent employee is excluded from active staffing totals and cannot clock into the original occurrence.
- Schedule changes refresh through the existing Supabase Realtime channel, and managers and employees can download their visible schedule as a standards-compliant `.ics` calendar file for Google Calendar, Apple Calendar, Outlook, and other calendar applications.

## Data and security

- Added forward-only migration `20260922145137_structured_late_arrival_and_coverage_markers.sql`.
- Existing schedule, punch, payroll, call-off, and accountability history is preserved. No historical row is deleted or rewritten.
- The new protected RPCs retain effective-permission and MFA checks. Personal schedule users receive only coverage markers connected to their own assignment or coverage case.
- A database trigger rejects an attempted clock-in by the called-off employee for the original scheduled occurrence; replacement employees use the separate coverage shift.

## Verification

- Full `pnpm check`: TypeScript, zero-warning lint, 301 test files / 1,604 tests, and both production builds.
- Mandatory Time Clock browser matrix: 42/42 desktop and mobile Chromium checks passed.
- Rollback-only production database rehearsal covered structured late entry, alert creation and automatic resolution, CALL OFF/COVERAGE mapping, and original-shift clock-in denial; no test data was retained.
- Calendar generation tests cover stable event identity, UTC times, escaped content, and employee-only filtering.

## Recovery

The application release can be restored to its pre-release Cloudflare version. The database migration is additive and forward-compatible. Any database correction must be delivered as a new forward migration; do not rewrite migration history or remove preserved attendance and coverage evidence.
