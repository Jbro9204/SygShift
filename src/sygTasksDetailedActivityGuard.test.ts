/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(join(
  process.cwd(),
  'supabase',
  'migrations',
  '20260910205447_sygtasks_detailed_activity.sql',
), 'utf8').toLowerCase()

describe('SygTasks detailed activity database boundary', () => {
  it('keeps activity reads task-authorized and available only to authenticated accounts', () => {
    expect(migration).toContain('security definer')
    expect(migration).toContain("set search_path = ''")
    expect(migration).toContain('actor_id uuid := private.current_employee_id()')
    expect(migration).toContain('private.sygtasks_can_view_task(actor_id, target_task_id)')
    expect(migration).toContain('revoke all on function public.get_sygtasks_task_activity(uuid,bigint,integer) from public, anon')
    expect(migration).toContain('grant execute on function public.get_sygtasks_task_activity(uuid,bigint,integer) to authenticated')
  })

  it('uses the existing task index and bounded keyset pagination', () => {
    expect(migration).toContain('activity.task_id = target_task_id')
    expect(migration).toContain('activity.id < target_before_id')
    expect(migration).toContain('limit clean_page_size + 1')
    expect(migration).toContain('clean_page_size not in (20, 50, 100)')
    expect(migration).toContain("'hasmore'")
    expect(migration).toContain("'nextbeforeid'")
  })

  it('enriches immutable records at read time without changing audit history', () => {
    expect(migration).toContain('join public.employees actor')
    expect(migration).toContain('left join public.employees subject')
    expect(migration).toContain('left join private.sygtasks_labels label')
    expect(migration).toContain('left join private.sygtasks_tasks related_task')
    expect(migration).not.toMatch(/update\s+private\.sygtasks_activity/)
    expect(migration).not.toMatch(/delete\s+from\s+private\.sygtasks_activity/)
  })
})
