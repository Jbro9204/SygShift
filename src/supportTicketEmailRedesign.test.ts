/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(join(
  process.cwd(),
  'supabase',
  'migrations',
  '20260921182231_support_ticket_email_redesign.sql',
), 'utf8')

describe('support ticket email redesign', () => {
  it('enriches the existing authorized delivery claim without changing routing', () => {
    expect(migration).toContain('create or replace function public.service_claim_support_ticket_notification_batch')
    expect(migration).toContain('private.support_employee_can_view(notification.recipient_employee_id, ticket)')
    expect(migration).toContain('for update of notification skip locked')
    expect(migration).toContain("'supportTicket', jsonb_build_object(")
    expect(migration).toContain("'submittedBy', btrim(concat(")
    expect(migration).toContain("'routeLabel', coalesce(permission.name")
    expect(migration).toContain("'impact', case when ticket.confidential then '{}'::jsonb else ticket.impact end")
    expect(migration).toContain("'technicalContext', case")
  })

  it('redacts confidential ticket content before it reaches email delivery', () => {
    expect(migration).toContain("case when ticket.confidential then 'Private HR or workplace concern' else ticket.subject end")
    expect(migration).toContain("when ticket.confidential then 'Protected details are available only inside SygShift.'")
    expect(migration).toContain("'impact', case when ticket.confidential then '{}'::jsonb else ticket.impact end")
    expect(migration).toContain("case when ticket.confidential then null else ticket.source_path end")
    expect(migration).toContain("when ticket.confidential or ticket.category <> 'technical' then '{}'::jsonb")
  })

  it('keeps the claim endpoint service-only', () => {
    expect(migration).toContain("if (select auth.role()) <> 'service_role' then")
    expect(migration).toContain('revoke all on function public.service_claim_support_ticket_notification_batch(integer)')
    expect(migration).toContain('grant execute on function public.service_claim_support_ticket_notification_batch(integer) to service_role')
  })
})
