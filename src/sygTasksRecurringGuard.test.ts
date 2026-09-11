/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(join(root, 'supabase', 'migrations', '20260912160000_sygtasks_recurring_work.sql'), 'utf8')
const data = readFileSync(join(root, 'src', 'data', 'sygtasks.ts'), 'utf8')
const dialogs = readFileSync(join(root, 'src', 'components', 'sygtasks', 'SygTasksDialogs.tsx'), 'utf8')
const panel = readFileSync(join(root, 'src', 'components', 'sygtasks', 'SygTasksRecurringPanel.tsx'), 'utf8')
const styles = readFileSync(join(root, 'src', 'styles', 'sygtasks.css'), 'utf8')
const worker = readFileSync(join(root, 'worker', 'index.ts'), 'utf8')

describe('SygTasks recurring work release boundary', () => {
  it('creates private series and occurrence ledgers with exactly-once dates', () => {
    expect(migration).toContain('create table private.sygtasks_recurring_series')
    expect(migration).toContain('create table private.sygtasks_recurring_occurrences')
    expect(migration).toContain('constraint sygtasks_recurring_occurrences_unique unique (series_id, occurrence_on)')
    expect(migration).toContain('for update skip locked')
    expect(migration).toContain('pg_advisory_xact_lock')
    expect(migration).toContain("auth.jwt() ->> 'role'), '') <> 'service_role'")
    expect(migration).not.toMatch(/drop (?:table|schema)/i)
    expect(migration).not.toMatch(/truncate /i)
    expect(migration).not.toMatch(/delete from (?:private|public)\./i)
  })

  it('keeps generated tasks independent and preserves history when a series changes', () => {
    expect(migration).toContain('insert into private.sygtasks_tasks')
    expect(migration).toContain("'recurrence', jsonb_build_object('seriesId'")
    expect(migration).toContain("clean_action not in ('pause', 'resume', 'cancel', 'skip_next', 'update_future')")
    expect(migration).toContain("raise check_violation using message = 'The next occurrence was already created. Open that task to cancel or change it.'")
    expect(migration).toContain("status_reason = 'board_archived'")
    expect(panel).toContain('Already-created tasks keep their own progress and history.')
    expect(panel).toContain('Future occurrences only')
  })

  it('walks users through recurrence, endings, time zones, and optional alerts', () => {
    expect(dialogs).toContain('Repeat this task')
    expect(dialogs).toContain('Choose the pattern')
    expect(dialogs).toContain('Choose when it ends')
    expect(dialogs).toContain('No end date')
    expect(dialogs).toContain('After a number')
    expect(data).toContain("'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'")
    expect(styles).toContain('.sygtasks-recurrence-builder')
    expect(styles).toContain('@media (max-width: 480px)')
  })

  it('generates before processing reminders in the isolated scheduled job', () => {
    const recurrenceCall = worker.indexOf("'service_process_due_sygtasks_recurring_series'")
    const reminderCall = worker.indexOf("'service_process_due_sygtasks_reminders'", recurrenceCall)
    expect(recurrenceCall).toBeGreaterThan(-1)
    expect(reminderCall).toBeGreaterThan(recurrenceCall)
    expect(worker).toContain('{ target_horizon_days: 7, target_limit: 50 }')
    expect(migration).toContain('perform private.reconcile_sygtasks_reminder(reminder_id)')
  })

  it('does not grant browser access to recurrence tables', () => {
    expect(migration).toContain('force row level security')
    expect(migration).toContain('revoke all on table private.sygtasks_recurring_series')
    expect(migration).not.toMatch(/grant .* on table private\.sygtasks_recurring/i)
    expect(migration).toContain('grant execute on function public.create_sygtasks_recurring_series(jsonb, uuid)')
    expect(migration).toContain('grant execute on function public.service_process_due_sygtasks_recurring_series(integer, integer) to service_role')
  })
})
