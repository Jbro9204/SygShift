/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(join(
  process.cwd(),
  'supabase',
  'migrations',
  '20260908143000_support_notification_routing_and_session_foundation.sql',
), 'utf8')

describe('support routing and notification data foundation', () => {
  it('keeps Dispatcher mapped to the protected role system and derives MFA from role policy', () => {
    expect(migration).toContain("access_role.code = 'system_dispatcher'")
    expect(migration).toContain("access_role.base_app_role = 'dispatcher'")
    expect(migration).toContain('create or replace function private.employee_requires_mfa')
    expect(migration).toContain('private.employee_requires_mfa(employee.id)')
    expect(migration).not.toContain("employee.role in ('dispatcher'")
    expect(migration).not.toContain("update public.employees set role")
  })

  it('separates full Admin access from automatic routed delivery', () => {
    expect(migration).toContain('create or replace function private.support_notification_recipients')
    expect(migration).toContain("access_role.code = 'system_admin'")
    expect(migration).toContain('not exists (select 1 from administrators admin where admin.id = employee.id)')
    expect(migration).toContain("'support.tickets.manage' = any(private.employee_effective_permissions(employee.id))")
    expect(migration).toContain('where not exists (select 1 from operational_handlers)')
    expect(migration).toContain('from private.support_notification_recipients(route_code)')
  })

  it('delivers replies only to the assigned handler or the opposite side of the conversation', () => {
    expect(migration).toContain('if actor_id = ticket.submitted_by then')
    expect(migration).toContain('private.support_employee_can_handle(ticket.assigned_to, ticket.route_permission)')
    expect(migration).toContain('elsif ticket.submitted_by <> actor_id then')
    expect(migration).toContain("concat('support:event:', target_event_id, ':recipient:', target_recipient_id)")
    expect(migration).toContain(') on conflict do nothing;')
  })

  it('consolidates the duplicate closed and resolved outcomes into Resolved', () => {
    expect(migration).toContain("set status = 'resolved'")
    expect(migration).toContain("where status = 'closed'")
    expect(migration).toContain("if new_status = 'closed' then new_status := 'resolved'; end if;")
    expect(migration).toContain("check (status in ('new', 'assigned', 'in_progress', 'waiting_on_employee', 'resolved', 'reopened'))")
  })

  it('clears dismissible notifications without bypassing required acknowledgements', () => {
    expect(migration).toContain('create or replace function public.clear_my_notifications()')
    expect(migration).toContain('not notification.requires_acknowledgement')
    expect(migration).toContain('or notification.acknowledged_at is not null')
    expect(migration).toContain("'remainingRequired', remaining_required_count")
    expect(migration).toContain("'CLEAR_ALL'")
    expect(migration).not.toContain('delete from public.employee_notifications')
    expect(migration).toContain('grant execute on function public.clear_my_notifications() to authenticated')
  })

  it('keeps status invalidation broad while batching bulk inbox refresh', () => {
    expect(migration).toContain('where private.support_employee_can_view(employee.id, new)')
    expect(migration).toContain("jsonb_build_object('kind', 'support', 'id', new.id)")
    expect(migration).toContain("current_setting('sygshift.suppress_notification_signal', true)")
    expect(migration).toContain("jsonb_build_object('kind', 'notification', 'operation', 'clear_all')")
  })

  it('prevents delivery after account or routed access is revoked', () => {
    expect(migration).toContain('Recipient no longer has access to this support ticket.')
    expect(migration).toContain('not private.support_employee_can_view(notification.recipient_employee_id, ticket)')
    expect(migration).toContain('grant execute on function public.service_claim_support_ticket_notification_batch(integer) to service_role')
    expect(migration).toContain('revoke all on function public.service_claim_support_ticket_notification_batch(integer) from public, anon, authenticated')
  })
})
