/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), 'utf8')

describe('system-wide protected identity verification trigger', () => {
  it('mounts one shared checkpoint host at the application boundary', () => {
    expect(read('src/App.tsx')).toContain('<IdentityVerificationHost />')
    expect(read('src/components/IdentityVerificationHost.tsx')).toContain('subscribeToIdentityVerification')
    expect(read('src/components/IdentityVerificationHost.tsx')).toContain('<IdentityVerificationModal')
  })

  it('routes every protected HR service client through automatic verification and retry', () => {
    const clients = [
      'src/data/hrAutomation.ts',
      'src/data/hrCompensation.ts',
      'src/data/hrDocumentWorkflows.ts',
      'src/data/hrOnboarding.ts',
      'src/data/hrRecruiting.ts',
      'src/data/hrStage7.ts',
      'src/data/hrStage8.ts',
      'src/data/hrStage9.ts',
      'src/data/hrStage10.ts',
    ]
    clients.forEach((path) => expect(read(path), path).toContain('documentApiRequest'))
    expect(read('src/data/hrDocuments.ts')).toContain('fetchWithIdentityVerification')
    expect(read('src/data/hrDocuments.ts')).toContain('requestIdentityVerification()')
  })

  it('covers protected administration, notification processing, and attendance reporting', () => {
    expect(read('src/data/adminUsers.ts')).toContain('fetchWithIdentityVerification')
    expect(read('src/data/operations.ts')).toContain('fetchWithIdentityVerification')
    expect(read('src/data/timekeeping.ts')).toContain('fetchWithIdentityVerification')
  })

  it('retries only explicit MFA-required responses and leaves authorization denials blocked', () => {
    const coordinator = read('src/lib/identityVerificationCoordinator.ts')
    expect(coordinator).toContain("code.endsWith('_mfa_required')")
    expect(coordinator).toContain("code === 'recent_document_mfa_required'")
    expect(coordinator).not.toContain("code.endsWith('_required')")
  })

  it('keeps a visible verify-and-retry action if compensation verification is dismissed', () => {
    expect(read('src/components/EmployeeCompensationCard.tsx')).toContain('Verify and retry')
    expect(read('src/components/EmployeeCompensationCard.tsx')).toContain('query.refetch()')
  })
})
