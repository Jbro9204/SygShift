/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(join(root, 'supabase', 'migrations', '20260830043000_hris_stage4_document_foundation.sql'), 'utf8')

const policy = JSON.parse(
  readFileSync(join(root, 'config', 'hris-document-security.json'), 'utf8'),
) as {
  release: { defaultEnabled: boolean }
  authorization: { recentMfaRequiredBeforeDocumentAccessRelease: boolean; recentMfaMaximumAgeSeconds: number; trustedDeviceAloneSatisfiesRecentMfa: boolean }
  storage: { publicObjectsAllowed: boolean; directBrowserObjectAccessAllowed: boolean }
  malware: { quarantineByDefault: boolean; previewBeforeCleanScanAllowed: boolean; downloadBeforeCleanScanAllowed: boolean }
  history: { versionsImmutable: boolean; legalHoldPreventsDisposition: boolean }
  vaults: string[]
}

describe('HRIS Stage 4 document foundation guardrails', () => {
  it('keeps the document release gate disabled until security and recovery evidence exists', () => {
    expect(policy.release.defaultEnabled).toBe(false)
    expect(migration).toContain("values (true, false)")
    expect(migration).toContain('Stage 4 document release gate must remain disabled.')
  })

  it('requires a fresh MFA challenge before any later document access release', () => {
    expect(policy.authorization.recentMfaRequiredBeforeDocumentAccessRelease).toBe(true)
    expect(policy.authorization.recentMfaMaximumAgeSeconds).toBe(900)
    expect(policy.authorization.trustedDeviceAloneSatisfiesRecentMfa).toBe(false)
    expect(migration).toContain('no more than 15 minutes old')
  })

  it('installs six private, independently permissioned vaults without browser object access', () => {
    expect(policy.vaults).toHaveLength(6)
    expect(policy.storage.publicObjectsAllowed).toBe(false)
    expect(policy.storage.directBrowserObjectAccessAllowed).toBe(false)
    for (const vault of policy.vaults) {
      expect(migration).toContain(`'${vault}'`)
    }
    expect(migration).toContain("('hr.documents.medical'")
    expect(migration).toContain("('hr.documents.identity'")
    expect(migration).not.toContain('create policy')
  })

  it('requires quarantine and clean scanner evidence before any later access release', () => {
    expect(policy.malware.quarantineByDefault).toBe(true)
    expect(policy.malware.previewBeforeCleanScanAllowed).toBe(false)
    expect(policy.malware.downloadBeforeCleanScanAllowed).toBe(false)
    expect(migration).toContain("'quarantined', 'scan_pending', 'clean', 'rejected', 'scan_error'")
    expect(migration).toContain('Clean scan results require evidence.')
  })

  it('preserves immutable versions, append-only access history, and legal holds', () => {
    expect(policy.history.versionsImmutable).toBe(true)
    expect(policy.history.legalHoldPreventsDisposition).toBe(true)
    expect(migration).toContain('hr_document_versions_immutable')
    expect(migration).toContain('hr_document_access_events_append_only')
    expect(migration).toContain('hr_document_active_legal_hold_unique')
    expect(migration).toContain('Document versions are immutable. Create a replacement version instead.')
  })

  it('does not mutate current people, identities, roles, or employee overrides', () => {
    expect(migration).toContain('hris_stage4_document_preservation_baseline')
    expect(migration).toContain('Stage 4 migration changed protected employee, identity, or access-control records.')
    expect(migration).not.toContain('insert into public.access_role_permissions')
    expect(migration).not.toContain('insert into public.employee_permission_overrides')
  })
})
