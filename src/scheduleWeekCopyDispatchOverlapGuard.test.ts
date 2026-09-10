/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260910165913_schedule_week_copy_dispatch_overlap_repair.sql'),
  'utf8',
)
const regression = readFileSync(
  join(root, 'supabase', 'tests', 'schedule_week_copy_dispatch_overlap_regression.sql'),
  'utf8',
)

describe('schedule week copy Dispatch overlap repair', () => {
  it('writes authoritative shift classification before copied assignments are validated', () => {
    const correctedInsert = migration.slice(
      migration.indexOf('corrected_insert text'),
      migration.indexOf('$corrected_insert$;', migration.indexOf('corrected_insert text')),
    )

    expect(correctedInsert).toContain('source_shift.work_type')
    expect(correctedInsert).toContain('source_shift.time_zone_source')
    expect(correctedInsert).toContain('source_shift.time_zone_employee_id')
    expect(correctedInsert).toContain('source_shift.assignment_type')
    expect(migration).toContain('The schedule week-copy function no longer matches the reviewed definition')
  })

  it('preserves the established authorization boundary', () => {
    expect(migration).toContain('from public, anon')
    expect(migration).toContain('to authenticated')
    expect(migration).toContain("notify pgrst, 'reload schema'")
  })

  it('covers a valid Dispatch overlap and a prohibited ordinary overlap in rollback-only SQL', () => {
    expect(regression).toContain("'dispatch_phone_duty'")
    expect(regression).toContain("'standard'")
    expect(regression).toContain('copiedAssignmentCount')
    expect(regression).toContain('ordinary_overlap_blocked')
    expect(regression.trimEnd().endsWith('rollback;')).toBe(true)
    expect((regression.match(/^begin;$/gm) ?? []).length).toBe(1)
    expect((regression.match(/^rollback;$/gm) ?? []).length).toBe(1)
    expect(regression).not.toMatch(/^commit;$/m)
  })
})
