import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

type Foundation = {
  releaseGate: {
    defaultEnabled: boolean
    protectedProductionDataAllowed: boolean
    requiredEvidence: string[]
  }
  securityDefaults: {
    authorization: string
    serverEnforced: boolean
    databaseEnforced: boolean
    directObjectAccessDenied: boolean
    listDefaultPageSize: number
    listMaximumPageSize: number
    auditMode: string
    breakGlass: {
      enabledByDefault: boolean
      maximumMinutes: number
      requiresRecentMfa: boolean
      requiresReason: boolean
      requiresSecondPersonReview: boolean
      audited: boolean
    }
  }
  modules: Array<{
    code: string
    readPermission: string
    writePermission: string
    sensitivePermission: string
    recentMfaForWrites: boolean
    featureFlag: string
  }>
  vaults: Array<{
    code: string
    private: boolean
    readPermission: string
    writePermission: string
  }>
  documentControls: Record<string, boolean>
}

const configPath = resolve(process.cwd(), 'config', 'hris-foundation-boundaries.json')
const foundation = JSON.parse(readFileSync(configPath, 'utf8')) as Foundation

describe('HRIS Stage 1 security foundation', () => {
  it('keeps every unfinished HR module and protected record behind a disabled release gate', () => {
    expect(foundation.releaseGate.defaultEnabled).toBe(false)
    expect(foundation.releaseGate.protectedProductionDataAllowed).toBe(false)
    expect(foundation.releaseGate.requiredEvidence).toEqual(expect.arrayContaining([
      'authorization-tests',
      'backup-restore-drill',
      'document-quarantine-validation',
      'rollback-validation',
    ]))
  })

  it('requires server and database enforcement instead of cosmetic permission checks', () => {
    expect(foundation.securityDefaults).toMatchObject({
      authorization: 'deny_by_default',
      serverEnforced: true,
      databaseEnforced: true,
      directObjectAccessDenied: true,
      auditMode: 'append_only',
    })
    expect(foundation.securityDefaults.listDefaultPageSize).toBeLessThanOrEqual(10)
    expect(foundation.securityDefaults.listMaximumPageSize).toBeLessThanOrEqual(100)
  })

  it('gives every planned module an independent permission and feature boundary', () => {
    expect(foundation.modules.length).toBeGreaterThanOrEqual(10)
    expect(new Set(foundation.modules.map(({ code }) => code)).size).toBe(foundation.modules.length)
    expect(new Set(foundation.modules.map(({ featureFlag }) => featureFlag)).size).toBe(foundation.modules.length)
    for (const module of foundation.modules) {
      expect(module.readPermission).toBeTruthy()
      expect(module.writePermission).toBeTruthy()
      expect(module.sensitivePermission).toBeTruthy()
      expect(module.recentMfaForWrites).toBe(true)
      expect(module.featureFlag).toMatch(/^hris_/)
    }
  })

  it('keeps every HR document family private and separately permissioned', () => {
    expect(foundation.vaults.map(({ code }) => code)).toEqual(expect.arrayContaining([
      'hr-general',
      'hr-financial',
      'hr-identity',
      'hr-medical',
      'hr-disciplinary',
      'hr-legal-safety',
    ]))
    for (const vault of foundation.vaults) {
      expect(vault.private).toBe(true)
      expect(vault.readPermission).not.toBe(vault.writePermission)
    }
    expect(foundation.documentControls).toMatchObject({
      publicAccess: false,
      directStorageUrls: false,
      quarantineRequired: true,
      malwareScanRequired: true,
      immutableVersions: true,
      legalHoldSupported: true,
      previewAudited: true,
      downloadAudited: true,
    })
  })

  it('makes emergency access temporary, reviewed, MFA-protected, and auditable', () => {
    expect(foundation.securityDefaults.breakGlass).toMatchObject({
      enabledByDefault: false,
      requiresRecentMfa: true,
      requiresReason: true,
      requiresSecondPersonReview: true,
      audited: true,
    })
    expect(foundation.securityDefaults.breakGlass.maximumMinutes).toBeLessThanOrEqual(60)
  })
})
