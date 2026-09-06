/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const form = readFileSync(join(root, 'src', 'components', 'SupportTicketForm.tsx'), 'utf8')
const page = readFileSync(join(root, 'src', 'pages', 'SupportTicketsPage.tsx'), 'utf8')
const navigation = readFileSync(join(root, 'src', 'app', 'navigation.ts'), 'utf8')
const shell = readFileSync(join(root, 'src', 'components', 'AppShell.tsx'), 'utf8')
const worker = readFileSync(join(root, 'worker', 'index.ts'), 'utf8')
const migration = readFileSync(join(root, 'supabase', 'migrations', '20260906125806_support_ticket_system.sql'), 'utf8')

describe('support ticket system', () => {
  it('keeps the thorough employee intake and permanent sidebar entry point', () => {
    expect(shell).toContain('<SupportHelpButton />')
    expect(form).toContain('Step ${step} of 4')
    expect(form).toContain('What do you need help with?')
    expect(form).toContain('Tell us what happened')
    expect(form).toContain('Impact, urgency, and privacy')
    expect(form).toContain('Review your request')
    expect(form).toContain('Do not wait for a support ticket during an active emergency.')
    expect(form).toContain('This is a private HR or workplace concern')
    expect(form).toContain('technicalContext')
  })

  it('keeps the staff queue restricted while every employee can open their own support route', () => {
    expect(navigation).toContain("label: 'Support Tickets'")
    expect(navigation).toContain("permissions: ['support.tickets.view', 'support.tickets.manage']")
    expect(page).toContain("workspace?.permissions.staffAccess ? 'Support Tickets' : 'My Support Tickets'")
    expect(migration).toContain("public.current_app_role() = 'admin'")
    expect(migration).toContain("target_ticket.submitted_by = private.current_employee_id()")
    expect(migration).toContain("public.has_effective_permission(target_ticket.route_permission)")
  })

  it('routes confidential and departmental tickets at the database boundary', () => {
    expect(migration).toContain("when target_confidential or target_category = 'human_resources' then 'hr.people.manage'")
    expect(migration).toContain("when target_category = 'timekeeping' then 'time.manage'")
    expect(migration).toContain("when target_category = 'payroll' then 'time.export_payroll'")
    expect(migration).toContain("when target_category = 'safety' then 'hr.safety.manage'")
    expect(migration).toContain("when target_category = 'technical' then 'admin.maintenance.manage'")
    expect(migration).toContain('force row level security')
    expect(migration).toContain('revoke all on table public.support_tickets')
  })

  it('queues auditable in-app and email lifecycle updates without emailing internal notes', () => {
    expect(migration).toContain('support_ticket_notifications')
    expect(migration).toContain("case when target_internal then 'internal' else 'public' end")
    expect(migration).toContain("if not target_internal then")
    expect(migration).toContain('service_claim_support_ticket_notification_batch')
    expect(worker).toContain("'service_claim_support_ticket_notification_batch'")
    expect(worker).toContain("relatedRecordType: 'support_ticket'")
    expect(page).toContain('Add as an internal note—do not email the requester')
  })
})
