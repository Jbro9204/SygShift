/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260922174500_accountability_lazy_reconciliation.sql'),
  'utf8',
)

describe('Accountability workspace performance repair', () => {
  it('moves expensive schedule reconciliation out of the list payload and behind one protected event request', () => {
    expect(migration).toContain("replace(function_definition, expensive_call, 'null::jsonb')")
    expect(migration).toContain('get_accountability_event_reconciliation(target_event_id uuid)')
    expect(migration).toContain("public.has_any_effective_permission(array['accountability.view', 'accountability.manage'])")
    expect(migration).toContain('private.get_accountability_reconciliation_group_snapshot(target_shift_id)')
  })

  it('does not rewrite attendance, schedule, punch, or review records', () => {
    expect(migration).not.toMatch(/update\s+public\.(attendance_accountability_events|shifts|schedules|time_events)/i)
    expect(migration).not.toMatch(/delete\s+from\s+public\./i)
    expect(migration).not.toMatch(/insert\s+into\s+public\./i)
  })
})
