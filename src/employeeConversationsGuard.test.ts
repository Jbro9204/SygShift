/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canAccessRoute } from './app/accessPolicy'

const root = process.cwd()
const migration = readFileSync(join(root, 'supabase', 'migrations', '20260917193852_employee_conversations_workspace.sql'), 'utf8')
const page = readFileSync(join(root, 'src', 'pages', 'EmployeeConversationsPage.tsx'), 'utf8')
const data = readFileSync(join(root, 'src', 'data', 'employeeConversations.ts'), 'utf8')
const people = readFileSync(join(root, 'src', 'pages', 'PeoplePage.tsx'), 'utf8')
const employeeFile = readFileSync(join(root, 'src', 'pages', 'HrisEmployeeFilePage.tsx'), 'utf8')
const styles = readFileSync(join(root, 'src', 'App.css'), 'utf8')

const session = (permissions: string[]) => ({ permissions })

describe('purpose-limited Employee Conversations workspace', () => {
  it('exposes the route only through the dedicated effective permission', () => {
    expect(canAccessRoute('/employee-conversations', session(['hr.conversations.view']))).toBe(true)
    expect(canAccessRoute('/employee-conversations', session(['directory.view']))).toBe(false)
    expect(canAccessRoute('/employee-conversations', session(['hr.people.view']))).toBe(false)
    expect(canAccessRoute('/employee-conversations', session([]))).toBe(false)
  })

  it('enforces direct-report scope in the database and reserves companywide review', () => {
    expect(migration).toContain("public.has_effective_permission('hr.conversations.review')")
    expect(migration).toContain('assignment.supervisor_employee_id = target_actor_id')
    expect(migration).toContain('assignment.employee_id = target_employee_id')
    expect(migration).toContain("('system_supervisor'::text, false)")
    expect(migration).toContain("('operations_manager'::text, true)")
    expect(migration).toContain("('human_resources'::text, true)")
    expect(migration).not.toContain('grant select on table private.hr_employee_conversations to authenticated')
    expect(migration).toContain('revoke all on table private.hr_employee_conversations from public, anon, authenticated')
  })

  it('preserves an append-only timeline without creating hidden discipline or points', () => {
    expect(migration).toContain('hr_employee_conversation_events_append_only')
    expect(migration).toContain("event_type in ('created', 'follow_up', 'completed', 'reopened', 'voided')")
    expect(migration).toContain("'disciplineCreated', false")
    expect(migration).toContain("'attendancePointsCreated', false")
    expect(migration).toContain("'CREATE_EMPLOYEE_CONVERSATION'")
    expect(migration).toContain("'EMPLOYEE_CONVERSATION_' || upper(event_type_value)")
    expect(migration).toContain('Employee Conversations installation must not create business records.')
  })

  it('provides a guided review-before-save flow and plain safe errors', () => {
    for (const step of ['Details', 'Facts', 'Next steps', 'Review']) expect(page).toContain(step)
    expect(page).toContain('Review the exact permanent record')
    expect(page).toContain('Save conversation')
    expect(page).toContain('Nothing is silently overwritten.')
    expect(page).toContain('This does not create discipline, attendance points, payroll changes')
    expect(data).toContain('safeServerMessages')
    expect(data).toContain('Employee Conversations could not be loaded. Please try again.')
  })

  it('connects authorized work from the Directory and Employee File without granting the full HR file', () => {
    expect(people).toContain('/employee-conversations?employeeId=')
    expect(people).toContain("sessionHasPermission(sessionQuery.data, 'hr.conversations.view')")
    expect(employeeFile).toContain('Employee Conversations')
    expect(employeeFile).toContain("canAccessRoute('/employee-conversations', sessionQuery.data)")
    expect(styles).toContain('.hr-file-tabs')
    expect(styles).toContain('.directory-actions')
  })

  it('keeps text controls readable, rounded, padded, and responsive', () => {
    expect(styles).toContain('.employee-conversation-wizard textarea')
    expect(styles).toContain('font-family: inherit')
    expect(styles).toContain('font-size: 1rem')
    expect(styles).toContain('border-radius: 10px')
    expect(styles).toContain('@media (max-width: 760px)')
  })
})
