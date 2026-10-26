/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migrations = [
  '20260821173000_payroll_review_set_based_performance.sql',
  '20260821174500_payroll_review_context_equivalence.sql',
  '20260821175000_occurrence_context_effective_event_performance.sql',
  '20260821175500_set_based_occurrence_identity.sql',
  '20260824234500_payroll_review_session_timeout_repair.sql',
].map((name) => readFileSync(join(process.cwd(), 'supabase', 'migrations', name), 'utf8'))

const [reviewMigration, equivalenceMigration, contextMigration, identityMigration, timeoutRepairMigration] = migrations
const singlePassMigration = readFileSync(join(
  process.cwd(),
  'supabase',
  'migrations',
  '20261026142340_payroll_review_single_pass_sources.sql',
), 'utf8')
const payrollBoundaryRegression = readFileSync(join(
  process.cwd(),
  'supabase',
  'tests',
  'payroll_week_elapsed_time_allocation_regression.sql',
), 'utf8')
const singlePassRegression = readFileSync(join(
  process.cwd(),
  'supabase',
  'tests',
  'payroll_review_single_pass_sources_regression.sql',
), 'utf8')
const boundedProjectionMigration = readFileSync(join(
  process.cwd(),
  'supabase',
  'migrations',
  '20261026142700_bound_payroll_effective_event_source.sql',
), 'utf8')
const boundedProjectionRegression = readFileSync(join(
  process.cwd(),
  'supabase',
  'tests',
  'bounded_effective_time_event_projection_regression.sql',
), 'utf8')
const boundedProjectionExplain = readFileSync(join(
  process.cwd(),
  'supabase',
  'tests',
  'bounded_effective_time_event_projection_explain.sql',
), 'utf8')
const canonicalContractMigration = readFileSync(join(
  process.cwd(),
  'supabase',
  'migrations',
  '20261026143200_canonical_timekeeping_review_contract.sql',
), 'utf8')
const canonicalContractRegression = readFileSync(join(
  process.cwd(),
  'supabase',
  'tests',
  'canonical_timekeeping_review_contract_regression.sql',
), 'utf8')
const timekeepingClient = readFileSync(join(process.cwd(), 'src', 'data', 'timekeeping.ts'), 'utf8')
const timePage = readFileSync(join(process.cwd(), 'src', 'pages', 'TimePage.tsx'), 'utf8')

describe('payroll review performance and occurrence integrity', () => {
  it('reads corrections and overrides once from a shared set-based punch source', () => {
    expect(reviewMigration).toContain('private.get_effective_time_events(')
    expect(reviewMigration).toContain('effective_events as materialized (')
    expect(reviewMigration).toContain('occurrence_contexts as (')
    expect(reviewMigration).toContain('payrollAssignmentAnchorSeed')
    expect(reviewMigration).toContain('payrollOccurrenceKeySeed')
  })

  it('retains occurrence-aware review for incomplete and multi-segment work', () => {
    expect(equivalenceMigration).toContain("not coalesce((base_row ->> 'sequenceComplete')::boolean, false)")
    expect(equivalenceMigration).toContain("coalesce((base_row ->> 'eventCount')::integer, 0) > 2")
    expect(equivalenceMigration).toContain('private.get_timekeeping_occurrence_context(')
    expect(equivalenceMigration).toContain("'validSequence'")
  })

  it('uses the shared effective-event source in both occurrence-context overloads', () => {
    expect(contextMigration).toContain("'private.get_timekeeping_occurrence_context(uuid,uuid,date)'::regprocedure")
    expect(contextMigration).toContain("'private.get_timekeeping_occurrence_context(uuid,uuid,date,timestamptz)'::regprocedure")
    expect(contextMigration).toContain('private.get_effective_time_events(target_employee_id)')
  })

  it('preserves immutable punch identity while resolving sessions without row-by-row correction scans', () => {
    expect(identityMigration).toContain('private.get_effective_time_events_with_occurrence(')
    expect(identityMigration).toContain('event.original_shift_id is not null')
    expect(identityMigration).toContain("'unscheduled-session:' || unscheduled.session_event_id::text")
    expect(identityMigration).toContain('event.occurrence_key = (select anchor.occurrence_key')
    expect(identityMigration).not.toContain('update public.time_events')
    expect(identityMigration).not.toContain('delete from public.time_events')
  })

  it('keeps payroll session assignment set-based for full pay-period reviews', () => {
    expect(timeoutRepairMigration).toContain('session_membership as materialized (')
    expect(timeoutRepairMigration).toContain('session_candidates as materialized (')
    expect(timeoutRepairMigration).toContain('rows between unbounded preceding and 1 preceding')
    expect(timeoutRepairMigration).toContain("target.effective_at - interval '24 hours'")
    expect(timeoutRepairMigration).toContain('private.get_effective_time_events(target_employee_id)')
    expect(timeoutRepairMigration).toContain("position('private.get_unscheduled_time_session_start(event.id' in review_sql) > 0")
    expect(timeoutRepairMigration).not.toContain('update public.time_events')
    expect(timeoutRepairMigration).not.toContain('delete from public.time_events')
  })

  it('builds ordinary main and prefix review sources once without bypassing the 46-day source limit', () => {
    expect(singlePassMigration).toContain('private.get_timekeeping_review_partitioned_sources(')
    expect(singlePassMigration).toContain("'mainPayload'")
    expect(singlePassMigration).toContain("'contextPayload'")
    expect(singlePassMigration).toContain("md5(original_sql) <> '9656bc6ff66fdf926a0c09c5f4852d24'")
    expect(singlePassMigration).toContain("md5(revised_sql) <> 'e244e55e85645ca05e7496588d860e8c'")
    expect(singlePassMigration).toContain('revised_function.proacl is distinct from original_function.proacl')
    expect(singlePassMigration).toContain('between context_from_date and target_through_date')
    expect(singlePassMigration).toContain('if target_through_date - target_context_from_date > 45')
    expect(singlePassMigration).toContain('or target_context_from_date < target_from_date - 1')
    expect(singlePassMigration).toContain('main_source_payload := private.get_timekeeping_review_pre_payroll_week_allocation(')
    expect(singlePassMigration).toContain("item.value ->> 'rowKind' = 'salary_default'")
    expect(singlePassMigration).toContain("nullif(item.value ->> 'weekStartsOn', '')::date")
    expect(singlePassMigration).toContain("nullif(item.value ->> 'weekEndsOn', '')::date")
    expect(singlePassMigration).not.toContain('update public.time_events')
    expect(singlePassMigration).not.toContain('delete from public.time_events')
  })

  it('retains executable coverage for prior-day open and corrected-week occurrences', () => {
    expect(payrollBoundaryRegression).toContain('A prior-Saturday open row may extend into Sunday')
    expect(payrollBoundaryRegression).toContain('Authorized corrected-week allocation became cosmetic')
    expect(payrollBoundaryRegression).toContain('Partial-week review lost prior-Saturday weekly OT context')
  })

  it('requires payload equivalence and application-timeout headroom across representative ranges', () => {
    expect(singlePassRegression).toContain("('prior_period', date '2026-10-04', date '2026-10-17')")
    expect(singlePassRegression).toContain("('current_period', date '2026-10-18', date '2026-10-31')")
    expect(singlePassRegression).toContain("('partial_week', date '2026-10-19', date '2026-10-24')")
    expect(singlePassRegression).toContain("('maximum_range', date '2026-09-04', date '2026-10-19')")
    expect(singlePassRegression).toContain("('empty_future', date '2099-01-04', date '2099-01-17')")
    expect(singlePassRegression).toContain("if target.case_name in ('current_period', 'empty_future') then")
    expect(singlePassRegression).toContain('candidate_elapsed_ms < 8000')
    expect(singlePassRegression.trimEnd()).toMatch(/rollback;$/)
  })

  it('indexes effective punch facts and expands exact session boundaries instead of scanning raw history', () => {
    expect(boundedProjectionMigration).toContain('private.timekeeping_effective_event_projection')
    expect(boundedProjectionMigration).toContain('timekeeping_effective_projection_at_idx')
    expect(boundedProjectionMigration).toContain('timekeeping_effective_projection_employee_at_idx')
    expect(boundedProjectionMigration).toContain('timekeeping_effective_projection_open_close_idx')
    expect(boundedProjectionMigration).toContain('private.refresh_timekeeping_effective_event_projection(')
    expect(boundedProjectionMigration).toContain('pg_advisory_xact_lock(')
    expect(boundedProjectionMigration).toContain('projection_backfill_watermark')
    expect(boundedProjectionMigration).toContain('do $catch_up_effective_event_projection$')
    expect(boundedProjectionMigration).toContain('New writes wait')
    expect(boundedProjectionMigration).toContain('after insert or update of approved_at, declined_at')
    expect(boundedProjectionMigration).toContain('previous_close.effective_at as previous_close_at')
    expect(boundedProjectionMigration).toContain('next_close.effective_at as next_close_at')
    expect(boundedProjectionMigration).toContain("coalesce(boundary.previous_close_at, '-infinity'::timestamptz)")
    expect(boundedProjectionMigration).toContain("coalesce(boundary.next_close_at, 'infinity'::timestamptz)")
    expect(boundedProjectionMigration).toContain('projection.effective_at, projection.recorded_at, projection.event_id')
    expect(boundedProjectionMigration).toContain("md5(pg_get_functiondef(effective_signature)) <>")
    expect(boundedProjectionMigration).toContain('revised_function.proacl is distinct from original_function.proacl')
    expect(boundedProjectionMigration).not.toContain('update public.time_events')
    expect(boundedProjectionMigration).not.toContain('delete from public.time_events')
  })

  it('covers far corrections, explicit shift ownership, >24-hour incomplete sessions, DST and idempotency', () => {
    expect(boundedProjectionRegression).toContain('A malformed unscheduled session exceeds 24 hours')
    expect(boundedProjectionRegression).toContain('Projection regression far-time correction.')
    expect(boundedProjectionRegression).toContain('Projection regression far occurrence.')
    expect(boundedProjectionRegression).toContain("timestamptz '2026-11-01 01:30:00-06'")
    expect(boundedProjectionRegression).toContain("timestamptz '2026-11-01 01:30:00-07'")
    expect(boundedProjectionRegression).toContain('Projection refresh is not idempotent.')
    expect(boundedProjectionRegression).toContain('to_jsonb(legacy) is distinct from to_jsonb(bounded)')
    expect(boundedProjectionRegression).toContain('Private effective-event projection privileges leaked.')
    expect(boundedProjectionRegression.trimEnd()).toMatch(/rollback;$/)
  })

  it('ships read-only EXPLAIN evidence for the exact indexed predicates and bounded resolver', () => {
    expect(boundedProjectionExplain).toContain('begin read only;')
    expect(boundedProjectionExplain).toContain('explain (analyze, buffers, wal, settings, format json)')
    expect(boundedProjectionExplain).toContain('timekeeping_effective_event_projection projection')
    expect(boundedProjectionExplain).toContain("projection.effective_kind = 'clock_out'")
    expect(boundedProjectionExplain).toContain('private.get_effective_time_events_bounded(')
    expect(boundedProjectionExplain).not.toMatch(/\b(insert|update|delete|truncate)\b/i)
    expect(boundedProjectionExplain.trimEnd()).toMatch(/rollback;$/)
  })

  it('returns category and work classification through one canonical review request', () => {
    expect(canonicalContractMigration).toContain('private.enrich_timekeeping_review_work_types(')
    expect(canonicalContractMigration).toContain('public.get_timekeeping_review_v2(')
    expect(canonicalContractMigration).toContain('public.get_timekeeping_review(target_from_date, target_through_date)')
    expect(canonicalContractMigration).toContain('if not public.has_mfa() then')
    expect(canonicalContractMigration).toContain('MFA verification is required to load payroll review details.')
    expect(canonicalContractMigration).toContain("coalesce(source.row_value -> 'eventTimeline', '[]'::jsonb)")
    expect(canonicalContractMigration).toContain('public.time_event_work_type_corrections')
    expect(canonicalContractMigration).not.toContain('update public.time_events')
    expect(canonicalContractMigration).not.toContain('delete from public.time_events')
    expect(timekeepingClient).toContain("rpc('get_timekeeping_review_v2'")
    expect(timePage).not.toMatch(/time-maintenance-review-summary[\s\S]{0,300}refetchInterval:/)
  })

  it('proves the canonical contract preserves calculations and exact event-bound classifications', () => {
    expect(canonicalContractRegression).toContain("candidate_without_enrichment - 'serverTimestamp'")
    expect(canonicalContractRegression).toContain("coalesce(review_row.value -> 'eventTimeline', '[]'::jsonb)")
    expect(canonicalContractRegression).toContain('candidate_under_app_timeout')
    expect(canonicalContractRegression).toContain('Anonymous canonical payroll review unexpectedly succeeded.')
    expect(canonicalContractRegression).toContain('Authenticated AAL1 canonical payroll review unexpectedly succeeded.')
    expect(canonicalContractRegression.trimEnd()).toMatch(/rollback;$/)
  })
})
