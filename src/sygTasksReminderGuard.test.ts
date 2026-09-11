/// <reference types="node" />

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(join(root, 'supabase', 'migrations', '20260911020000_sygtasks_task_reminders.sql'), 'utf8')
const repair = readFileSync(join(root, 'supabase', 'migrations', '20260911021000_sygtasks_assignee_reminder_variable_repair.sql'), 'utf8')
const worker = readFileSync(join(root, 'worker', 'index.ts'), 'utf8')
const alarmHost = readFileSync(join(root, 'src', 'components', 'SygTasksAlarmHost.tsx'), 'utf8')
const alarmStyles = readFileSync(join(root, 'src', 'components', 'SygTasksAlarmHost.css'), 'utf8')
const reminders = readFileSync(join(root, 'src', 'components', 'sygtasks', 'SygTasksRemindersPanel.tsx'), 'utf8')

describe('SygTasks reminder and alarm contract', () => {
  it('stores private definitions and per-recipient occurrences without destructive behavior', () => {
    expect(migration).toContain('create table private.sygtasks_task_reminders')
    expect(migration).toContain('create table private.sygtasks_task_reminder_occurrences')
    expect(migration).toContain('force row level security')
    expect(migration).toContain('on delete restrict')
    expect(migration).toContain("recipient_scope in ('self', 'assignees')")
    expect(migration).toContain("state in ('scheduled', 'triggered', 'snoozed', 'acknowledged', 'cancelled')")
    expect(migration).not.toMatch(/drop (?:table|schema)/i)
    expect(migration).not.toMatch(/truncate /i)
    expect(migration).not.toMatch(/delete from (?:private|public)\./i)
  })

  it('reconciles task and assignment changes and processes due work idempotently', () => {
    expect(migration).toContain('after update of due_at, status, archived_at')
    expect(migration).toContain('after insert or update of removed_at')
    expect(migration).toContain("task_record.status = 'done'")
    expect(migration).toContain("cancellation_reason = 'recipient_removed'")
    expect(migration).toContain('for update of occurrence skip locked')
    expect(migration).toContain("concat('sygtasks-reminder:', due_record.occurrence_id, ':', delivery_number)")
    expect(migration).toContain('private.create_employee_notification')
    expect(migration).toContain('public.employee_notification_email_deliveries')
    expect(worker).toContain("'service_process_due_sygtasks_reminders'")
    expect(worker).toContain("event: 'sygtasks_scheduled_work_failed'")
  })

  it('keeps browser access behind scoped RPCs and the service processor behind service_role', () => {
    expect(migration.match(/security definer/g)?.length).toBeGreaterThanOrEqual(9)
    expect(migration.match(/set search_path = ''/g)?.length).toBeGreaterThanOrEqual(9)
    expect(migration).toContain("auth.jwt() ->> 'role'), '') <> 'service_role'")
    expect(migration).toContain('grant execute on function public.service_process_due_sygtasks_reminders(integer) to service_role')
    expect(migration).not.toMatch(/grant .* on table private\./i)
  })

  it('ships the production forward repair for the assignee reminder variable boundary', () => {
    expect(repair).toContain('create or replace function public.create_sygtasks_task_reminder')
    expect(repair).toContain('selected_task_id uuid')
    expect(repair).toContain('where assignee.task_id = selected_task_id')
    expect(repair).not.toMatch(/where assignee\.task_id = task_id\b/)
    expect(repair).toContain('grant execute on function public.create_sygtasks_task_reminder(jsonb, uuid) to authenticated')
  })

  it('ships separate one-time reminders, persistent alarms, explicit controls, and a single-tab sound lease', () => {
    expect(reminders).toContain('Reminders &amp; alarms')
    expect(reminders).toContain('My private reminder')
    expect(reminders).toContain('Current task assignees')
    expect(reminders).toContain('Also send email')
    expect(reminders).toContain('saveSoundPreferences')
    expect(reminders).toContain('alarm: true, muted: false')
    expect(reminders).toContain('opening the task does not silence it')
    expect(alarmHost).toContain('navigator.locks.request')
    expect(alarmHost).toContain('Stop alarm')
    expect(alarmHost).toContain('Snooze')
    expect(alarmHost).toContain('Open task')
    expect(alarmHost).toContain('Mark complete')
    expect(alarmHost).toContain('alarmRepeatDelayMs = 3_000')
    expect(alarmHost).toContain('playAlarmSoundCycle')
    expect(alarmHost).toContain('alarm: true, muted: false')
    expect(alarmStyles).toContain('.sygtasks-alarm-host .sygtasks-button')
    expect(alarmStyles).toContain('.sygtasks-alarm-host .sygtasks-button--primary')
    expect(alarmStyles).toContain('.sygtasks-alarm-host .sygtasks-notice--error')
  })

  it('uses the approved content-versioned alarm audio', () => {
    const audio = readFileSync(join(root, 'public', 'sounds', 'SygTasks_Alarm_6aa3fd61.mp3'))
    expect(createHash('sha256').update(audio).digest('hex')).toBe('6aa3fd616b52905480d596c7a747d7129687ab3845ccc307565b7aef16506198')
  })
})
