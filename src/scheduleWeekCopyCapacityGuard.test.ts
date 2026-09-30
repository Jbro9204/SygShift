import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  'supabase/migrations/20260930195833_schedule_week_copy_timezone_lookup_cache.sql',
  'utf8',
)
const regression = readFileSync(
  'supabase/tests/schedule_week_copy_capacity_regression.sql',
  'utf8',
)
const approvedTimeOffMigration = readFileSync(
  'supabase/migrations/20260930201111_schedule_week_copy_approved_time_off_skip.sql',
  'utf8',
)

describe('schedule week-copy capacity timeout repair', () => {
  it('caches valid IANA time-zone names once without weakening the reviewed function boundary', () => {
    expect(migration).toContain('valid_time_zone_names text[]')
    expect(migration).toContain('array_agg(zone.name order by zone.name)')
    expect(migration).toContain('array_position(valid_time_zone_names, source_shift.time_zone)')
    expect(migration).toContain('array_position(valid_time_zone_names, destination_time_zone)')
    expect(migration).toContain("notify pgrst, 'reload schema'")
    expect(migration).toContain("'The schedule week-copy execution boundary was not preserved.'")
    expect(migration).toContain("'authenticated'")
    expect(migration).toContain("'anon'")
    expect(migration).toContain('security definer')
    expect(migration).toContain("set search_path to ' || quote_literal('')")
  })

  it('fails closed unless its generated definition contains one cached catalog lookup', () => {
    expect(migration).toContain(
      "length(updated_sql) - length(replace(updated_sql, 'pg_catalog.pg_timezone_names', '')) <> length('pg_catalog.pg_timezone_names')",
    )
    expect(migration).toContain(
      "length(installed_definition) - length(replace(installed_definition, 'pg_catalog.pg_timezone_names', '')) <> length('pg_catalog.pg_timezone_names')",
    )
    expect(migration).toContain(
      "'The schedule week-copy timeout repair could not be verified before installation.'",
    )
    expect(migration).toContain(
      "'The schedule week-copy timeout repair did not install completely.'",
    )
  })

  it('keeps a current-size, authenticated, rollback-only capacity regression', () => {
    expect(regression).toContain('generate_series(1, 142) shift_number')
    expect(regression).toContain('generate_series(1, 136) guard_number')
    expect(regression).toContain('generate_series(1, 136) assignment_number')
    expect(regression).toContain("set local statement_timeout = '7s';")
    expect(regression).toContain('set local role authenticated;')
    expect(regression).toContain('"aal":"aal2"')
    expect(regression).toContain('replace_schedule_week_draft_with_work_types')
    expect(regression).toContain("(copy_result ->> 'copiedCount')::integer = 142")
    expect(regression).toContain("(copy_result ->> 'copiedAssignmentCount')::integer = 135")
    expect(regression).toContain("(copy_result ->> 'skippedApprovedTimeOffAssignmentCount')::integer = 1")
    expect(regression).toContain("(copy_result ->> 'replacedCount')::integer = 1")
    expect(regression).toContain('The 135 eligible copied shifts were not marked covered.')
    expect(regression).toContain('The six originally open and one approved-leave shift were not left open.')
    expect(regression).toContain("'dispatch_phone_duty'")
    expect(regression).toContain("'replace_week_draft_from_revision'")
    expect(regression.trimEnd().endsWith('rollback;')).toBe(true)
    expect((regression.match(/^begin;$/gm) ?? [])).toHaveLength(1)
    expect((regression.match(/^rollback;$/gm) ?? [])).toHaveLength(1)
    expect(regression).not.toMatch(/^commit;$/m)
  })

  it('leaves approved-time-off coverage open without weakening assignment enforcement', () => {
    expect(approvedTimeOffMigration).toContain('private.lock_employee_schedule_time_off(source_assignment.employee_id)')
    expect(approvedTimeOffMigration).toContain("nullif(request.submission_snapshot ->> 'timeZone', '')")
    expect(approvedTimeOffMigration).toContain("tstzrange(shifted_start, shifted_end, '[)')")
    expect(approvedTimeOffMigration).toContain('skipped_approved_time_off_assignment_count')
    expect(approvedTimeOffMigration).toContain('skippedApprovedTimeOffAssignmentCount')
    expect(approvedTimeOffMigration).toContain('continue;')
    expect(approvedTimeOffMigration).toContain('security definer')
    expect(approvedTimeOffMigration).toContain("set search_path to ' || quote_literal('')")
    expect(regression).toContain('Approved leave for copied-week capacity coverage.')
    expect(regression).toContain("'skipped_approved_time_off_assignment_count')::integer = 1")
  })
})
