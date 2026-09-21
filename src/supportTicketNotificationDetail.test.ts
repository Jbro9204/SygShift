/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(join(
  process.cwd(),
  'supabase',
  'migrations',
  '20260921185816_support_ticket_notification_detail.sql',
), 'utf8')

describe('support ticket notification detail and delivery repair', () => {
  it('routes tickets to every active authorized handler including Administrators', () => {
    expect(migration).toContain('create or replace function private.support_notification_recipients')
    expect(migration).toContain("access_role.code = 'system_admin'")
    expect(migration).toContain("'support.tickets.view' = any(private.employee_effective_permissions(employee.id))")
    expect(migration).toContain("'support.tickets.manage' = any(private.employee_effective_permissions(employee.id))")
    expect(migration).not.toContain('where not exists (select 1 from operational_handlers)')
  })

  it('creates a useful and privacy-aware in-app ticket notification', () => {
    expect(migration).toContain('create or replace function private.sync_support_ticket_notification_to_inbox')
    expect(migration).toContain("'Submitted by: '")
    expect(migration).toContain("E'\\nPriority: '")
    expect(migration).toContain("E'\\nCategory: '")
    expect(migration).toContain("E'\\nRouted to: '")
    expect(migration).toContain("E'\\n\\nSummary: '")
    expect(migration).toContain('Immediate safety concern')
    expect(migration).toContain('Upcoming shift affected')
    expect(migration).toContain('Pay may be affected')
    expect(migration).toContain("when ticket.confidential then 'Private HR or workplace concern'")
    expect(migration).toContain('Protected details are available only inside the authorized Support Tickets workspace.')
  })

  it('preserves inbox state while restoring recent missing authorized deliveries', () => {
    const conflictUpdate = migration
      .split('on conflict (source_key) do update')[1]
      ?.split('end\n$$;')[0] ?? ''
    expect(migration).toContain('on conflict (source_key) do update')
    expect(conflictUpdate).not.toContain('dismissed_at =')
    expect(conflictUpdate).not.toContain('read_at =')
    expect(conflictUpdate).not.toContain('acknowledged_at =')
    expect(migration).toContain("ticket.created_at >= clock_timestamp() - interval '14 days'")
    expect(migration).toContain("ticket.status not in ('resolved', 'closed')")
    expect(migration).toContain("notification.message_type = 'support_ticket_opened'")
    expect(migration).toContain('private.queue_support_ticket_notification(')
  })

  it('keeps the synchronization routines unavailable to browser roles', () => {
    expect(migration).toContain('revoke all on function private.support_notification_recipients(text)')
    expect(migration).toContain('revoke all on function private.sync_support_ticket_notification_to_inbox(uuid)')
    expect(migration).toContain('revoke all on function private.mirror_support_ticket_notification()')
  })
})
