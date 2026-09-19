import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const repositoryMap = readFileSync(join(root, 'COMMUNICATIONS_REPO_MAP.md'), 'utf8')
const contract = readFileSync(join(root, 'shared/sygsphere-communications/v1/contract.ts'), 'utf8')
const manifest = JSON.parse(readFileSync(join(root, 'shared/sygsphere-communications/v1/contract-manifest.json'), 'utf8')) as {
  contractVersion: string
  protocolVersion: number
  owner: string
  artifactDigestSha256: string
  authority: { forbiddenBrowserAuthorityFields: string[] }
}
const commandSchema = JSON.parse(readFileSync(join(root, 'shared/sygsphere-communications/v1/command-envelope.schema.json'), 'utf8')) as {
  additionalProperties: boolean
  properties: Record<string, unknown>
}
const eventSchema = JSON.parse(readFileSync(join(root, 'shared/sygsphere-communications/v1/event-envelope.schema.json'), 'utf8')) as {
  additionalProperties: boolean
  properties: Record<string, unknown>
}
const spike = readFileSync(join(root, 'tools/validate-sygsphere-communications-provider-spike.mjs'), 'utf8')
const spikeRunbook = readFileSync(join(root, 'docs/operations/SYGSPHERE_COMMUNICATIONS_PROVIDER_SPIKE.md'), 'utf8')

describe('SygSphere Communications Stage 0/1 contract guard', () => {
  it('keeps SygShift as the canonical identity, membership, notification, and migration owner', () => {
    expect(repositoryMap).toContain('SygShift owns')
    expect(repositoryMap).toContain('public.sygsphere_request(...)')
    expect(repositoryMap).toContain('private.employee_effective_permissions(uuid)')
    expect(repositoryMap).toContain('private.sygsphere_tenants')
    expect(repositoryMap).toContain('Sygilant consumes the exact generated artifacts')
  })

  it('uses a strict versioned envelope without browser-supplied authority', () => {
    expect(manifest.contractVersion).toBe('1.0.0-draft.1')
    expect(manifest.protocolVersion).toBe(1)
    expect(manifest.owner).toBe('SygShift')
    const digest = createHash('sha256')
    for (const file of ['contract.ts', 'command-envelope.schema.json', 'event-envelope.schema.json']) {
      digest.update(readFileSync(join(root, 'shared/sygsphere-communications/v1', file)))
    }
    expect(manifest.artifactDigestSha256).toBe(digest.digest('hex'))
    expect(commandSchema.additionalProperties).toBe(false)
    expect(eventSchema.additionalProperties).toBe(false)
    expect(commandSchema.properties).not.toHaveProperty('tenantId')
    expect(commandSchema.properties).not.toHaveProperty('employeeId')
    expect(manifest.authority.forbiddenBrowserAuthorityFields).toEqual(expect.arrayContaining(['tenantId', 'providerSecret']))
    expect(contract).toContain("SYGSPHERE_COMMS_CONTRACT_VERSION = '1.0.0-draft.1'")
  })

  it('defines the least-privilege communications capability set and a disabled-by-default provider spike', () => {
    for (const permission of [
      'sygsphere.comms.use',
      'sygsphere.comms.ptt.transmit',
      'sygsphere.comms.call.start',
      'sygsphere.comms.screen.publish',
      'sygsphere.comms.configure',
    ]) expect(contract).toContain(`'${permission}'`)
    expect(spike).toContain("process.argv.includes('--execute-turn-credential-check')")
    expect(spike).toContain("COMMS_SPIKE_ENVIRONMENT === 'staging'")
    expect(spike).toContain('I_UNDERSTAND_THIS_CREATES_STAGING_TURN_CREDENTIALS')
    expect(spike).toContain('Credential material is intentionally omitted')
    expect(spikeRunbook).toContain('two-physical-device matrix remains blocked')
    expect(spikeRunbook).toContain('Not run')
  })
})
