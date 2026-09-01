/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(join(root, 'supabase', 'migrations', '20260902080000_action_center_history.sql'), 'utf8')
const page = readFileSync(join(root, 'src', 'pages', 'ActionCenterPage.tsx'), 'utf8')
const data = readFileSync(join(root, 'src', 'data', 'actionCenter.ts'), 'utf8')

describe('Action Center history guardrails', () => {
  it('keeps terminal records out of the active queue', () => {
    expect(migration).toContain("acknowledgment.status in ('pending', 'viewed')")
    expect(migration).toContain("assignment.status in ('assigned', 'in_progress')")
    expect(migration).not.toMatch(/where acknowledgment\.employee_id = actor_id\s+and acknowledgment\.status <> 'superseded'/)
  })

  it('reads every supported history source without copying or mutating it', () => {
    expect(migration).toContain('from public.announcement_acknowledgments acknowledgment')
    expect(migration).toContain('from public.training_assignments assignment')
    expect(migration).toContain('from public.schedule_acknowledgments acknowledgment')
    expect(migration).toContain('from private.hr_workflow_tasks task')
    expect(migration).toContain('Action Center history changed an authoritative action record.')
    expect(migration).not.toMatch(/insert into public\.(announcement_acknowledgments|training_assignments|schedule_acknowledgments)/)
    expect(migration).not.toMatch(/update public\.(announcement_acknowledgments|training_assignments|schedule_acknowledgments)/)
    expect(migration).not.toMatch(/delete from public\.(announcement_acknowledgments|training_assignments|schedule_acknowledgments)/)
  })

  it('keeps team history source-permission scoped and MFA protected', () => {
    expect(migration).toContain("public.has_effective_permission('announcements.acknowledgments.manage')")
    expect(migration).toContain("public.has_effective_permission('training.manage')")
    expect(migration).toContain("public.has_effective_permission('schedule.acknowledgments.manage')")
    expect(migration).toContain("public.has_effective_permission('hr.automation.manage')")
    expect(migration).toContain('and public.has_mfa()')
    expect(migration).toContain("target_scope = 'self'")
    expect(migration).toContain("target_scope = 'team'")
  })

  it('uses compact bounded pagination and a read-only detail experience', () => {
    expect(migration).toContain('target_page_size in (5, 10, 20)')
    expect(migration).toContain('limit page_size offset row_offset')
    expect(data).toContain('pageSize?: 5 | 10 | 20')
    expect(page).toContain("useState<5 | 10 | 20>(10)")
    expect(page).toContain('Needs Attention')
    expect(page).toContain('In Progress')
    expect(page).toContain('History')
    expect(page).toContain('This is a read-only audit record.')
    expect(page).not.toContain('Reopen action')
  })
})
