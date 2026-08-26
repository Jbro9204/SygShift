# SygShift Change Log — Automatic Clock-Out Revision Continuity

**Date:** 08/26/2026  
**Area:** Time & Attendance / Production Automation  
**Status:** Released and verified

## Incident

An employee remained clocked in after the scheduled end of a shift. The company-wide audit confirmed that the one-minute Cloudflare scheduled job was running normally, but its database candidate selection could omit an otherwise valid open session after the schedule was republished.

## Root cause

SygShift publishes schedules as immutable revisions. When a new revision is published, the prior published revision becomes `superseded`. Time punches correctly retain the exact original shift ID for audit history. The automatic clock-out routine, however, only considered shifts whose parent revision was still marked `published`.

This meant a valid open punch could become invisible to automatic clock-out when its schedule revision was superseded after the employee clocked in.

## Correction

- Automatic clock-out now follows the exact shift linked to the employee's open session when the parent schedule is `published` or `superseded`.
- Draft and archived schedules remain excluded.
- The scheduled shift end remains authoritative; the system does not invent worked time.
- Existing idempotency and duplicate-clock-out protection remain in place.
- Missing-clock-in detection remains limited to the current published schedule so historical revisions cannot create false or duplicate alerts.
- Existing punches and shift relationships were not modified.

## System-wide reconciliation

- Audited all active employee clock states, recent scheduled-job runs, and overdue session candidates.
- Confirmed the scheduled job had no failures during the preceding 24 hours.
- The first production run after the correction safely created one missing automatic clock-out for an unambiguous overdue scheduled session.
- Confirmed zero overdue scheduled sessions remained afterward.
- Preserved one unrelated supervisor-entered open session without a linked shift for human review because it has no authoritative scheduled end.

## Verification

- Type checking passed.
- Lint passed with warnings denied.
- All 76 test files and 385 tests passed.
- Production build passed.
- Current Wrangler startup analysis passed.
- `https://app.sygilant.us/api/v1/health` returned healthy.
- `https://app.sygilant.us/api/v1/ready` returned ready with all required bindings available.
- Production automation continued running every minute with zero failed runs and zero overdue scheduled candidates.

## Files

- `supabase/migrations/20260826100000_auto_clock_out_revision_continuity.sql`
- `src/automaticClockOutRevisionContinuityGuard.test.ts`
