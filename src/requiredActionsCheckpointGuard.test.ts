import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(join(root, 'supabase', 'migrations', '20260912120000_mandatory_required_actions_checkpoint.sql'), 'utf8')
const shell = readFileSync(join(root, 'src', 'components', 'AppShell.tsx'), 'utf8')
const notice = readFileSync(join(root, 'src', 'components', 'RequiredActionsCheckpointNotice.tsx'), 'utf8')
const worker = readFileSync(join(root, 'worker', 'index.ts'), 'utf8')

describe('mandatory required-actions checkpoint guardrails', () => {
  it('derives one queue from authoritative versioned sources without copying business records', () => {
    for (const source of [
      'announcement_acknowledgments',
      'training_assignments',
      'schedule_acknowledgments',
      'hr_workflow_tasks',
      'hr_document_assignments',
      'signature_recipients',
    ]) expect(migration).toContain(source)
    expect(migration).toContain('employee_required_action_checkpoint_rows')
    expect(migration).toContain('authoritative_version')
    expect(migration).toContain('required_action_checkpoint_preservation_baseline')
    expect(migration).toContain("rollout_mode in ('canary', 'all')")
    expect(migration).toContain('required_action_checkpoint_enrollments')
  })

  it('enforces the checkpoint at the effective-permission boundary while preserving urgent employee actions', () => {
    expect(migration).toContain('employee_has_blocking_required_actions')
    expect(migration).toContain("('time.punch'::text)")
    expect(migration).toContain("('time.self.view'::text)")
    expect(migration).toContain("('accountability.report_call_off'::text)")
    expect(migration).toContain("('actions.self.view'::text)")
    expect(migration).toContain("('documents.signatures.sign_own'::text)")
    expect(migration).toContain('service_has_required_action_checkpoint')
    expect(worker).toContain('requiredActionCheckpointAllowsMutation')
    expect(worker).toContain("'service_has_required_action_checkpoint'")
    expect(worker).toContain("pathname === '/api/v1/time/attendance/report'")
  })

  it('gates ordinary routes only after the existing password and MFA checkpoint', () => {
    expect(shell.indexOf('needsSecurityCheckpoint && !isAccountSecurityRoute')).toBeLessThan(shell.indexOf('requiredActionCheckpointActive && !checkpointAllowsLocation'))
    expect(shell).toContain("pathname === '/time/my-time' && new URLSearchParams(search).get('report') === 'call-off'")
    expect(shell).toContain('RequiredActionsCheckpointNotice')
  })

  it('explains action-specific evidence and retains emergency guidance', () => {
    expect(notice).toContain('Action 1 of')
    expect(notice).toContain('authoritativeVersion')
    expect(migration).toContain('Acknowledgment confirms receipt and review')
    expect(notice).toContain('call 911')
    expect(notice).toContain('Report sick / call-off')
  })
})
