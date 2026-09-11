import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(join(root, 'supabase', 'migrations', '20260912130000_guided_corrective_action_workflow.sql'), 'utf8')
const worker = readFileSync(join(root, 'worker', 'index.ts'), 'utf8')
const manager = readFileSync(join(root, 'src', 'components', 'CorrectiveActionsWorkspace.tsx'), 'utf8')
const employee = readFileSync(join(root, 'src', 'pages', 'ActionCenterPage.tsx'), 'utf8')

describe('guided corrective-action workflow guardrails', () => {
  it('preserves one restricted canonical HR case and immutable response history', () => {
    expect(migration).toContain("case_type, title, status")
    expect(migration).toContain("'corrective_action'")
    expect(migration).toContain('hr_corrective_action_responses_append_only')
    expect(migration).toContain('hr_corrective_action_events_append_only')
    expect(migration).toContain('Guided corrective-action migration changed protected business or access records.')
  })

  it('requires an independent qualified HR reviewer before private delivery', () => {
    expect(migration).toContain('A different qualified HR reviewer must make this decision.')
    expect(migration).toContain("action_record.status <> 'approved'")
    expect(worker).toContain("requireSessionPermission(session.context, 'hr.cases.manage')")
    expect(manager).toContain('Waiting for a different qualified HR reviewer.')
  })

  it('does not misrepresent receipt as employee agreement', () => {
    const receipt = 'My acknowledgment confirms receipt and review; it does not mean that I agree with the record.'
    expect(migration).toContain(receipt)
    expect(employee).toContain('Acknowledge receipt only')
    expect(employee).toContain('Dispute this record')
    expect(employee).toContain('Decline acknowledgment')
  })

  it('adds delivered records to the required-action checkpoint without copying them', () => {
    expect(migration).toContain('employee_required_action_checkpoint_base_rows')
    expect(migration).toContain("'corrective_action'")
    expect(migration).toContain("action.status='delivered'")
    expect(migration).toContain('employee_required_action_checkpoint_enrolled')
  })

  it('provides a guided four-step manager flow and employee response flow', () => {
    for (const step of ['Employee', 'Facts', 'Expectations', 'Review']) expect(manager).toContain(step)
    expect(manager).toContain('Submit for HR review')
    expect(manager).toContain('Deliver privately')
    expect(employee).toContain('Save my response')
  })
})
