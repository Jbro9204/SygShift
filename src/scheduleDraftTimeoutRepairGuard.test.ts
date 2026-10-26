import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const indexMigration = readFileSync(
  'supabase/migrations/20261026141835_schedule_draft_timeout_repair.sql',
  'utf8',
)
const cloneMigration = readFileSync(
  'supabase/migrations/20261026142017_schedule_draft_set_based_clone.sql',
  'utf8',
)
const regression = readFileSync(
  'supabase/tests/schedule_draft_timeout_repair_regression.sql',
  'utf8',
)
const indexRecovery = readFileSync(
  'supabase/recovery/20261026141835_schedule_draft_timeout_repair.sql',
  'utf8',
)
const cloneRecovery = readFileSync(
  'supabase/recovery/20261026142017_schedule_draft_set_based_clone.sql',
  'utf8',
)
const cloneRecoveryRegression = readFileSync(
  'supabase/tests/schedule_draft_set_based_clone_recovery_regression.sql',
  'utf8',
)
const copyOnWriteMigration = readFileSync(
  'supabase/migrations/20261026151000_schedule_edit_copy_on_write.sql',
  'utf8',
)
const schedulePage = readFileSync('src/pages/SchedulePage.tsx', 'utf8')
const scheduleData = readFileSync('src/data/schedule.ts', 'utf8')
const copyOnWriteRegression = readFileSync(
  'supabase/tests/schedule_edit_copy_on_write_regression.sql',
  'utf8',
)
const copyOnWriteRecovery = readFileSync(
  'supabase/recovery/20261026151000_schedule_edit_copy_on_write.sql',
  'utf8',
)
const priorEnsureDraftMigration = readFileSync(
  'supabase/migrations/20260802103000_scheduler_manual_notifications_and_week_copy.sql',
  'utf8',
)
const priorDuplicateNormalizerMigration = readFileSync(
  'supabase/migrations/20260913175135_absence_coverage_workflow.sql',
  'utf8',
)

function sqlFunctionDefinition(source: string, signature: string) {
  const start = source.indexOf(signature)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('\n$$;', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end + '\n$$;'.length)
}

describe('schedule draft timeout repair', () => {
  it('builds the assignment-override lookup online without masking an invalid prior build', () => {
    expect(indexMigration).toContain('create index concurrently schedule_assignment_overrides_shift_employee_created_idx')
    expect(indexMigration).toContain('(shift_id, employee_id, created_at desc)')
    expect(indexMigration).not.toContain('if not exists')
    expect(indexMigration).not.toMatch(/^\s*begin;/m)
    expect(indexMigration).not.toMatch(/^\s*commit;/m)
    expect(indexRecovery).toContain('drop index concurrently public.schedule_assignment_overrides_shift_employee_created_idx;')
    expect(indexRecovery).not.toMatch(/^\s*begin;/m)
  })

  it('clones the full revision set-wise while retaining ordinary trigger enforcement', () => {
    expect(cloneMigration).toContain("md5(pg_get_functiondef(ensure_function.oid)) <> 'b14f552161e0a3df53604bfd9067838c'")
    expect(cloneMigration).toContain("md5(pg_get_functiondef(normalize_function.oid)) <> 'df3b5a57e81dcb7f426a45c8a7f0e3f6'")
    expect(cloneMigration).toContain('ensure_function.proacl::text is distinct from')
    expect(cloneMigration).toContain('normalize_function.proacl::text is distinct from')
    expect(cloneMigration).toContain("jsonb_object_agg(source_shift.id::text, gen_random_uuid())")
    expect(cloneMigration).toContain('insert into public.shifts (')
    expect(cloneMigration).toContain('insert into public.schedule_assignment_overrides (')
    expect(cloneMigration).toContain('insert into public.shift_assignments (')
    expect(cloneMigration).toContain("order by assignment.employee_id, source_shift.starts_at")
    expect(cloneMigration).toContain('join public.shifts source_shift on source_shift.id = override_record.shift_id')
    expect(cloneMigration).toContain('where source_shift.schedule_id = source_schedule.id')
    expect(cloneMigration).toContain('with copied_assignment_counts as (')
    expect(cloneMigration).toContain('where copied_shift.schedule_id = new_schedule_id')
    expect(cloneMigration).toContain('copied_shift.is_open is distinct from')
    expect(cloneMigration).not.toContain('disable trigger')
    expect(cloneMigration).not.toContain('session_replication_role')
    expect(cloneMigration).toContain("position('perform private.copy_schedule_shift_block(' in ensure_sql) > 0")
  })

  it('limits duplicate normalization to the target schedule', () => {
    expect(cloneMigration).toContain('with target_shifts as materialized (')
    expect(cloneMigration).toContain('where shift.schedule_id = target_schedule_id')
    expect(cloneMigration).toContain('from target_shifts target_shift')
    expect(cloneMigration).toContain('join public.shift_assignments assignment on assignment.shift_id = target_shift.id')
  })

  it('can recover the committed 142017 boundary when 151000 fails transactionally', () => {
    expect(cloneRecovery).toContain('schedule_set_based_clone_recovery_preflight')
    expect(cloneRecovery).toContain('schedule_set_based_clone_recovery_postflight')
    expect(cloneRecovery).toContain("position('jsonb_object_agg(source_shift.id::text, gen_random_uuid())' in ensure_sql) = 0")
    expect(cloneRecovery).toContain("position('with target_shifts as materialized (' in normalize_sql) = 0")
    expect(cloneRecovery).toContain('The copy-on-write release is present; use the guarded 151000 recovery instead.')
    expect(cloneRecovery).toContain("md5(pg_get_functiondef(ensure_function.oid)) <> 'b14f552161e0a3df53604bfd9067838c'")
    expect(cloneRecovery).toContain("md5(pg_get_functiondef(normalize_function.oid)) <> 'df3b5a57e81dcb7f426a45c8a7f0e3f6'")
    expect(sqlFunctionDefinition(
      cloneRecovery,
      'create or replace function public.ensure_schedule_draft(target_week_starts_on date)',
    )).toBe(sqlFunctionDefinition(
      priorEnsureDraftMigration,
      'create or replace function public.ensure_schedule_draft(target_week_starts_on date)',
    ))
    expect(sqlFunctionDefinition(
      cloneRecovery,
      'create or replace function private.normalize_schedule_duplicate_shift_blocks(target_schedule_id uuid)',
    )).toBe(sqlFunctionDefinition(
      priorDuplicateNormalizerMigration,
      'create or replace function private.normalize_schedule_duplicate_shift_blocks(target_schedule_id uuid)',
    ))
    expect(cloneRecovery).not.toContain('drop function public.scheduler_materialize_and_update_shift_v1')
    expect(cloneRecovery).not.toContain('drop function private.materialize_schedule_draft_revision')
    expect(cloneRecovery).not.toContain('rename to get_weekly_schedule_payload')
    expect(cloneRecovery).not.toContain('drop table')
    expect(cloneRecovery).not.toContain('drop index')
    expect(cloneRecovery.trimEnd().endsWith('commit;')).toBe(true)

    expect(cloneRecoveryRegression).toContain('141835 committed, 142017 committed, 151000 failed transactionally')
    expect(cloneRecoveryRegression).toContain('schedule_assignment_overrides_shift_employee_created_idx')
    expect(cloneRecoveryRegression).toContain('The failed 151000 transaction left copy-on-write objects behind.')
    expect(cloneRecoveryRegression).toContain("md5(pg_get_functiondef(ensure_function.oid)) <> 'b14f552161e0a3df53604bfd9067838c'")
    expect(cloneRecoveryRegression).toContain("md5(pg_get_functiondef(normalize_function.oid)) <> 'df3b5a57e81dcb7f426a45c8a7f0e3f6'")
    expect(cloneRecoveryRegression.trimEnd().endsWith("select 'schedule_draft_set_based_clone_recovery_regression: PASS' as result;")).toBe(true)
    expect((cloneRecoveryRegression.match(/^begin;$/gm) ?? [])).toHaveLength(1)
    expect((cloneRecoveryRegression.match(/^rollback;$/gm) ?? [])).toHaveLength(1)
    expect(cloneRecoveryRegression).not.toMatch(/^commit;$/m)
  })

  it('keeps realistic-volume, idempotency, open-state, and atomicity regression coverage', () => {
    expect(regression).toContain('generate_series(1, 124)')
    expect(regression).toContain('generate_series(1, 122)')
    expect(regression).toContain('generate_series(1, 10000)')
    expect(regression).toContain("set local statement_timeout = '7s';")
    expect(regression).toContain("set local \"request.jwt.claims\" = '{\"aal\":\"aal1\"}';")
    expect(regression).toContain('An employee without schedule-management access created a draft.')
    expect(regression).toContain('An AAL1 schedule manager created a draft.')
    expect(regression).toContain("perform public.ensure_schedule_draft(date '2099-10-04');")
    expect(regression).toContain('Repeated draft preparation was not idempotent.')
    expect(regression).toContain('The two unassigned draft shifts were not the only open shifts.')
    expect(regression).toContain('The draft assignment evidence did not match the published source.')
    expect(regression).toContain('The draft override evidence did not match the published source.')
    expect(regression).toContain('The explicit ensure-draft audit event was not preserved exactly once.')
    expect(regression).toContain('The schedule draft function security boundary changed.')
    expect(regression).toContain('controlled atomic clone failure')
    expect(regression).toContain('A failed clone retained a partial draft schedule.')
    expect(regression.trimEnd().endsWith('rollback;')).toBe(true)
    expect((regression.match(/^begin;$/gm) ?? [])).toHaveLength(1)
    expect((regression.match(/^rollback;$/gm) ?? [])).toHaveLength(1)
    expect(regression).not.toMatch(/^commit;$/m)
  })

  it('opens the shift editor read-only and materializes the revision only on Save', () => {
    const editShiftBlock = schedulePage.slice(
      schedulePage.indexOf('function editShift(shift: ScheduleShift)'),
      schedulePage.indexOf('function openVacancyPatrolRecovery'),
    )
    expect(editShiftBlock).toContain("status: 'ready'")
    expect(editShiftBlock).not.toContain('ensureDraftMutation.mutate')
    expect(editShiftBlock).not.toContain('Opening a working draft')
    expect(scheduleData).toContain("rpc('scheduler_materialize_and_update_shift_v1'")
    expect(scheduleData).toContain('expected_shift_version: input.expectedVersionToken')
    expect(schedulePage).toContain("expectedVersionToken: shift.versionToken ?? ''")
  })

  it('stores exact source-to-draft lineage and performs clone plus edit atomically', () => {
    const atomicUpdate = copyOnWriteMigration.slice(
      copyOnWriteMigration.indexOf('create function public.scheduler_materialize_and_update_shift_v1'),
      copyOnWriteMigration.indexOf('revoke all on function public.scheduler_materialize_and_update_shift_v1'),
    )
    expect(copyOnWriteMigration).toContain('create table private.schedule_shift_revision_links')
    expect(copyOnWriteMigration).toContain('primary key (draft_schedule_id, source_shift_id)')
    expect(copyOnWriteMigration).toContain('schedule_shift_revision_links_draft_shift_idx')
    expect(copyOnWriteMigration).toContain('draft_matches_for_source = 1')
    expect(copyOnWriteMigration).toContain('set draft_shift_id = survivor.id')
    expect(copyOnWriteMigration).toContain('create function private.materialize_schedule_draft_revision')
    expect(copyOnWriteMigration).toContain('create function public.scheduler_materialize_and_update_shift_v1')
    expect(copyOnWriteMigration).toContain('private.schedule_shift_version_token')
    expect(copyOnWriteMigration).toContain('target_schedule_status public.schedule_status')
    expect(copyOnWriteMigration).toContain('target_schedule_updated_at timestamptz')
    expect(copyOnWriteMigration).toContain("'versionToken'")
    expect(copyOnWriteMigration).toContain("'assignment_type', shift.assignment_type")
    expect(copyOnWriteMigration).toContain("'work_type', shift.work_type")
    expect(copyOnWriteMigration).toContain("'payrollCategory', shift.payroll_category")
    expect(copyOnWriteMigration).toContain('expected_shift_version is distinct from current_shift_version')
    expect(copyOnWriteMigration).toContain('A working draft was created after this published shift was opened.')
    expect(atomicUpdate.indexOf("pg_advisory_xact_lock(hashtext('schedule-draft:'")).toBeLessThan(
      atomicUpdate.indexOf('select schedule.* into source_schedule'),
    )
    expect(atomicUpdate).toContain('This schedule was published after the editor opened.')
    expect(copyOnWriteMigration).toContain('draft_schedule_id := private.materialize_schedule_draft_revision')
    expect(copyOnWriteMigration).toContain('updated_payload := public.scheduler_update_typed_draft_shift_with_payroll_category_v1')
    expect(copyOnWriteMigration).toContain('return private.add_schedule_shift_version_tokens(updated_payload)')
    expect(copyOnWriteMigration).toContain('The schedule changed after this shift was opened.')
    expect(copyOnWriteMigration).toContain("payload_function.proacl::text is distinct from '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'")
    expect(copyOnWriteMigration).toContain('grant execute on function public.get_weekly_schedule_payload(date) to authenticated, service_role;')
    expect(copyOnWriteMigration).not.toContain('matching_shift_ids')
    expect(copyOnWriteMigration).not.toContain('disable trigger')
    expect(copyOnWriteMigration).not.toContain('session_replication_role')
    expect(copyOnWriteRegression).toContain('A denied edit materialized a draft.')
    expect(copyOnWriteRegression).toContain('The published source shift was changed.')
    expect(copyOnWriteRegression).toContain('A repeated stale Save duplicated the revision or shift lineage.')
    expect(copyOnWriteRegression).toContain('A stale direct-draft editor overwrote a concurrent save.')
    expect(copyOnWriteRegression).toContain('The stale-save rejection did not preserve the concurrent edit.')
    expect(copyOnWriteRegression).toContain('The assigned employee was not preserved through materialization and edit.')
    expect(copyOnWriteRegression).toContain('The assignment override evidence was not preserved through materialization and edit.')
    expect(copyOnWriteRegression).toContain('The saved draft payload did not return the final row-backed shift fields.')
    expect(copyOnWriteRegression.indexOf('insert into public.schedule_assignment_overrides (')).toBeLessThan(
      copyOnWriteRegression.indexOf('insert into public.shift_assignments ('),
    )
    expect(copyOnWriteRegression).toContain('A failed Save retained a partial draft.')
    expect(copyOnWriteRegression.trimEnd().endsWith('rollback;')).toBe(true)
    expect((copyOnWriteRegression.match(/^begin;$/gm) ?? [])).toHaveLength(1)
    expect((copyOnWriteRegression.match(/^rollback;$/gm) ?? [])).toHaveLength(1)
    expect(copyOnWriteRecovery).toContain('schedule_copy_on_write_recovery_preflight')
    expect(copyOnWriteRecovery).toContain("position('with target_shifts as materialized (' in normalize_sql) = 0")
    expect(copyOnWriteRecovery).toContain("position('insert into private.schedule_shift_revision_links' in materializer_sql) = 0")
    expect(copyOnWriteRecovery).toContain("md5(pg_get_functiondef(ensure_function.oid)) <> 'b14f552161e0a3df53604bfd9067838c'")
    expect(copyOnWriteRecovery).toContain("md5(pg_get_functiondef(normalize_function.oid)) <> 'df3b5a57e81dcb7f426a45c8a7f0e3f6'")
    expect(copyOnWriteRecovery).toContain('rename to get_weekly_schedule_payload')
    expect(copyOnWriteRecovery).toContain("payload_function.proacl::text is distinct from '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'")
    expect(copyOnWriteRecovery).toContain('to authenticated, service_role;')
    expect(copyOnWriteRecovery).toContain('drop function private.materialize_schedule_draft_revision(date)')
    expect(sqlFunctionDefinition(
      copyOnWriteRecovery,
      'create or replace function public.ensure_schedule_draft(target_week_starts_on date)',
    )).toBe(sqlFunctionDefinition(
      priorEnsureDraftMigration,
      'create or replace function public.ensure_schedule_draft(target_week_starts_on date)',
    ))
    expect(sqlFunctionDefinition(
      copyOnWriteRecovery,
      'create or replace function private.normalize_schedule_duplicate_shift_blocks(target_schedule_id uuid)',
    )).toBe(sqlFunctionDefinition(
      priorDuplicateNormalizerMigration,
      'create or replace function private.normalize_schedule_duplicate_shift_blocks(target_schedule_id uuid)',
    ))
    expect(copyOnWriteRecovery.trimEnd().endsWith('commit;')).toBe(true)
    expect(copyOnWriteRecovery).not.toContain('drop table')
  })
})
