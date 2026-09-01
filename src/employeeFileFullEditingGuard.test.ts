/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync('supabase/migrations/20260902010000_employee_file_editing_and_pay_rates.sql', 'utf8')
const page = readFileSync('src/pages/HrisEmployeeFilePage.tsx', 'utf8')
const editors = readFileSync('src/components/EmployeeFileEditors.tsx', 'utf8')
const compensation = readFileSync('src/components/EmployeeCompensationCard.tsx', 'utf8')
const compensationData = readFileSync('src/data/hrCompensation.ts', 'utf8')
const worker = readFileSync('worker/index.ts', 'utf8')
const css = readFileSync('src/App.css', 'utf8')

describe('full Employee File editing release', () => {
  it('adds the requested workforce and emergency-contact fields without guessing existing values', () => {
    expect(migration).toContain('add column if not exists work_classification text')
    expect(migration).toContain("work_classification in ('full_time', 'part_time', 'flex')")
    expect(migration).toContain('add column if not exists emergency_contact_relationship text')
    expect(migration).toContain('add column if not exists emergency_contact_email text')
    expect(editors).toContain('<option value="full_time">Full Time</option>')
    expect(editors).toContain('<option value="part_time">Part Time</option>')
    expect(editors).toContain('<option value="flex">Flex</option>')
    expect(migration).not.toMatch(/set\s+work_classification\s*=\s*'(?:full_time|part_time|flex)'/i)
  })

  it('requires MFA, exact permissions, a reason, and audit history for employee-file changes', () => {
    expect(migration).toContain('private.require_hr_people_viewer()')
    expect(migration).toContain("public.has_effective_permission('hr.people.manage')")
    expect(migration).toContain("public.has_effective_permission('hr.people.restricted')")
    expect(migration).toContain("raise check_violation using message = 'A reason of 1 to 1,000 characters is required.'")
    expect(migration).toContain("'UPDATE_HR_IDENTITY'")
    expect(migration).toContain("'UPDATE_HR_EMPLOYMENT_PROFILE'")
    expect(migration).toContain("'UPDATE_HR_CONTACT_DETAILS'")
    expect(migration).toContain('insert into private.audit_events')
  })

  it('keeps pay amounts outside the general Employee File and behind the protected Worker boundary', () => {
    expect(page).toContain('EmployeeCompensationCard')
    expect(compensationData).toContain('/api/v1/hr/compensation/employees/')
    expect(worker).toContain("requireSessionPermission(session.context, 'hr.compensation.view')")
    expect(worker).toContain("requireSessionPermission(session.context, 'hr.compensation.manage')")
    expect(worker).toContain("requireSessionPermission(session.context, 'hr.compensation.approve')")
    expect(worker).toContain('requireRecentDocumentMfa(request, session)')
    expect(migration).toContain("proposal_record.proposed_by = target_actor_id")
    expect(migration).toContain('to service_role')
    expect(migration).toContain('from public, anon, authenticated')
  })

  it('keeps employee and compensation lists bounded', () => {
    expect(migration).toContain('limit 5')
    expect(migration).toContain('limit row_limit')
    expect(compensation).toContain('pendingProposals.map')
    expect(compensation).toContain('record.history.map')
  })

  it('uses one rounded raised visual treatment for urgent home actions', () => {
    expect(css).toContain('.home-time-strip__actions .urgent-action-button')
    expect(css).toContain('border-radius: 12px')
    expect(css).toContain('box-shadow: 0 4px 0 #5f1713')
    expect(css).toContain('transform: translateY(2px)')
  })
})
