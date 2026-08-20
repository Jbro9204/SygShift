/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260820190000_scheduler_draft_add_shift_repair.sql'),
  'utf8',
)
const schedulePage = readFileSync(join(root, 'src', 'pages', 'SchedulePage.tsx'), 'utf8')

describe('scheduler add-shift draft integrity', () => {
  it('reuses the authoritative working draft instead of publishing during save', () => {
    expect(migration).toContain('perform public.ensure_schedule_draft(target_week_starts_on);')
    expect(migration).toContain("schedule.status = 'draft'")
    expect(migration).toContain('new_schedule_id := latest_schedule.id;')
    expect(migration).toContain("'add_to_draft'")
    expect(migration).toContain("status = ''published''' in updated_sql) > 0")
  })

  it('does not deliver a prepared opening announcement until the draft is published', () => {
    expect(migration).toContain('private.publish_prepared_schedule_announcements()')
    expect(migration).toContain('announcement.published_at is null')
    expect(migration).toContain("new.status = 'published'")
  })

  it('keeps the scheduler language aligned with the draft transaction', () => {
    expect(schedulePage).toContain('Saves to the working schedule draft')
    expect(schedulePage).toContain("'Saving draft...'")
    expect(schedulePage).toContain("'draft shift'")
  })
})
