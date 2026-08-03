/// <reference types="node" />

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const schedulePage = readFileSync(join(root, 'src', 'pages', 'SchedulePage.tsx'), 'utf8')
const appStyles = readFileSync(join(root, 'src', 'App.css'), 'utf8')
const scheduleData = readFileSync(join(root, 'src', 'data', 'schedule.ts'), 'utf8')
const employeeScopedPublishMigration = readFileSync(
  join(root, 'supabase', 'migrations', '20260731161500_employee_scoped_schedule_publish.sql'),
  'utf8',
)
const manualScheduleNotificationMigration = readFileSync(
  join(root, 'supabase', 'migrations', '20260802103000_scheduler_manual_notifications_and_week_copy.sql'),
  'utf8',
)
const atomicWeekCopyMigration = readFileSync(
  join(root, 'supabase', 'migrations', '20260803183000_schedule_week_copy_atomic_replacement.sql'),
  'utf8',
)

describe('scheduler behavior guardrails', () => {
  it('closes the assignment modal after Save assignment succeeds', () => {
    expect(schedulePage).toContain('function closePlannerAssignmentAfterSave()')
    expect(schedulePage).toContain('setSelectedPlannerShiftId(null)')
    expect(schedulePage).toContain('Assignment saved. Publish the draft when the week is ready.')

    const directDraftSave = /draftShiftMutationInput\(shift, employeeId, availabilityOverrideNote, credentialOverrideNote\),\s*\{\s*onSuccess: closePlannerAssignmentAfterSave\s*\}/
    const openedDraftSave = /draftShiftMutationInput\(copiedShift, employeeId, availabilityOverrideNote, credentialOverrideNote\),\s*\{\s*onSuccess: closePlannerAssignmentAfterSave\s*\}/

    expect(schedulePage).toMatch(directDraftSave)
    expect(schedulePage).toMatch(openedDraftSave)
  })

  it('uses draft-safe language when adding shifts from the scheduler', () => {
    expect(schedulePage).toContain("'Saving draft...'")
    expect(schedulePage).toContain('busyLabel="Saving schedule draft..."')
    expect(schedulePage).toContain('Save ${openShiftDateKeys.length === 1 ? \'draft shift\'')
    expect(schedulePage).toContain('Save ${openShiftDateKeys.length === 1 ? \'open draft shift\'')
    expect(schedulePage).toContain('assigned draft shift${createdCount === 1 ? \'\' : \'s\'} saved')
    expect(schedulePage).toContain('open draft shift${createdCount === 1 ? \'\' : \'s\'} saved')

    const addShiftButtonBlock = /createOpenShiftMutation\.isPending[\s\S]+?<\/button>/.exec(schedulePage)?.[0] ?? ''
    expect(addShiftButtonBlock).not.toContain('Publishing...')
    expect(addShiftButtonBlock).not.toContain('Publish ${openShiftDateKeys.length === 1 ? \'assigned shift\'')
    expect(addShiftButtonBlock).not.toContain('Publish ${openShiftDateKeys.length === 1 ? \'open shift\'')
  })

  it('closes the full shift editor after a draft shift save succeeds', () => {
    const editSubmitBlock = /function submit\(event: FormEvent<HTMLFormElement>\) \{[\s\S]+?mutation\.mutate\(\{[\s\S]+?\}, \{\s*onSuccess: onClose,\s*\}\)/.exec(schedulePage)?.[0] ?? ''

    expect(editSubmitBlock).toContain('shiftId: shift.id')
    expect(editSubmitBlock).toContain('onSuccess: onClose')
  })

  it('supports publishing one employee schedule without publishing the full week', () => {
    expect(scheduleData).toContain('publish_employee_schedule_slice')
    expect(schedulePage).toContain('publishEmployeeScheduleMutation')
    expect(schedulePage).toContain('Publish ${selectedEmployeeWeekRow.name} only')
    expect(schedulePage).toContain('The rest of the week remains in draft.')
    expect(schedulePage).toContain('Publish full week')
    expect(employeeScopedPublishMigration).toContain('public.publish_employee_schedule_slice')
    expect(employeeScopedPublishMigration).toContain('rebased_draft_schedule_id')
    expect(employeeScopedPublishMigration).toContain("status = 'archived'")
  })

  it('keeps schedule notifications manual after a schedule is published', () => {
    const publishDraftBlock = manualScheduleNotificationMigration.slice(
      manualScheduleNotificationMigration.indexOf('create or replace function public.publish_schedule_draft'),
      manualScheduleNotificationMigration.indexOf('create or replace function public.queue_schedule_published_notification'),
    )

    expect(scheduleData).toContain('queue_schedule_published_notification')
    expect(schedulePage).toContain('notifyScheduleMutation')
    expect(schedulePage).toContain('processNotificationBatch()')
    expect(schedulePage).toContain('Notify employees')
    expect(schedulePage).toContain('Send schedule notification')
    expect(publishDraftBlock).toContain("'notification_queued', false")
    expect(publishDraftBlock).not.toContain('private.notification_outbox')
    expect(manualScheduleNotificationMigration).toContain('create or replace function public.queue_schedule_published_notification')
    expect(manualScheduleNotificationMigration).toContain('schedule-published-manual:')
  })

  it('atomically replaces a destination draft from the exact visible revision', () => {
    expect(scheduleData).toContain('replace_schedule_week_draft_from_revision')
    expect(scheduleData).toContain('source_schedule_id: input.sourceScheduleId')
    expect(schedulePage).toContain('copyWeekMutation')
    expect(schedulePage).toContain('Copy week')
    expect(schedulePage).toContain('Copy into draft')
    expect(schedulePage).toContain('Nothing publishes and no notification sends')
    expect(schedulePage).toContain('I understand this will replace the destination working draft.')
    expect(atomicWeekCopyMigration).toContain('create or replace function public.replace_schedule_week_draft_from_revision')
    expect(atomicWeekCopyMigration).toContain('where schedule.id = source_schedule_id')
    expect(atomicWeekCopyMigration).toContain("and schedule.status = 'draft'")
    expect(atomicWeekCopyMigration).toContain("'replace_week_draft_from_revision'")
    expect(atomicWeekCopyMigration).toContain('The week copy was canceled because the destination did not match the source revision.')
    expect(atomicWeekCopyMigration).toContain("and employee.status = 'active'")
    expect(atomicWeekCopyMigration.indexOf('insert into public.schedule_assignment_overrides')).toBeLessThan(
      atomicWeekCopyMigration.indexOf('insert into public.shift_assignments (', atomicWeekCopyMigration.indexOf('for source_assignment in')),
    )
  })

  it('fits all seven employee schedule days inside the scheduler board', () => {
    expect(schedulePage).toContain('className="scheduler-day-board"')
    const schedulerBoardStyles = /\.scheduler-day-board \{[\s\S]+?\}/.exec(appStyles)?.[0] ?? ''

    expect(schedulerBoardStyles).toContain('grid-template-columns: repeat(7, minmax(0, 1fr))')
    expect(schedulerBoardStyles).toContain('overflow-x: hidden')
  })
})
