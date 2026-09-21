import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SYGSPHERE_COMMS_TURN_CREDENTIAL_TTL_SECONDS } from '../worker/comms/turnCredentialPolicy'

const coordinator = readFileSync(resolve(import.meta.dirname, '..', 'worker/comms/tenantCommsDurableObject.ts'), 'utf8')
const policyImport = "import { SYGSPHERE_COMMS_TURN_CREDENTIAL_TTL_SECONDS } from './turnCredentialPolicy'"
const issuance = 'adapter.generateIceServers(SYGSPHERE_COMMS_TURN_CREDENTIAL_TTL_SECONDS)'

const methodBody = (name: string): string => {
  const signature = `  async ${name}(`
  const start = coordinator.indexOf(signature)
  expect(start, `Could not locate ${name} in the communications coordinator.`).toBeGreaterThanOrEqual(0)
  const nextMethod = coordinator.indexOf('\n  async ', start + signature.length)
  return coordinator.slice(start, nextMethod === -1 ? undefined : nextMethod)
}

describe('SygSphere Communications TURN credential lifetime', () => {
  it('uses a server-owned twelve-hour credential lifetime within the provider maximum', () => {
    expect(SYGSPHERE_COMMS_TURN_CREDENTIAL_TTL_SECONDS).toBe(12 * 60 * 60)
    expect(SYGSPHERE_COMMS_TURN_CREDENTIAL_TTL_SECONDS).toBeLessThanOrEqual(48 * 60 * 60)
    expect(SYGSPHERE_COMMS_TURN_CREDENTIAL_TTL_SECONDS).toBeGreaterThan(0)
  })

  it('uses that one credential lifetime for every direct, meeting, and PTT media issuance path', () => {
    expect(coordinator).toContain(policyImport)
    expect(coordinator).not.toMatch(/generateIceServers\(\s*300\s*\)/)

    for (const operation of [
      'prepareDirectAudio',
      'startDirectAudio',
      'prepareMeetingMedia',
      'startMeetingMedia',
      'startPttAudio',
      'preparePttAudio',
      'startPttListen',
      'preparePttListen',
    ]) {
      expect(methodBody(operation), `${operation} must use the server-owned TURN credential lifetime.`).toContain(issuance)
    }

    expect(coordinator.match(/adapter\.generateIceServers\(/g)).toHaveLength(8)
  })
})
