import { describe, expect, it } from 'vitest'
import { deriveSystemServiceStatus, type SystemReadiness } from './systemStatus'

const ready: SystemReadiness = {
  checks: {
    assetsBinding: true,
    supabasePublishableKey: true,
    supabaseServiceRoleKey: true,
    supabaseUrl: true,
  },
  ready: true,
  requestId: 'request-id',
  status: 'ready',
}

function baseInput() {
  return {
    configured: true,
    maintenanceAccessModes: [],
    maintenanceError: false,
    maintenancePending: false,
    readiness: ready,
    readinessError: false,
    readinessPending: false,
  }
}

describe('deriveSystemServiceStatus', () => {
  it('reports online only after readiness and maintenance checks succeed', () => {
    expect(deriveSystemServiceStatus(baseInput()).state).toBe('online')
  })

  it('reports attention for an active notice or read-only maintenance window', () => {
    expect(deriveSystemServiceStatus({ ...baseInput(), maintenanceAccessModes: ['notice'] }).state).toBe('attention')
    expect(deriveSystemServiceStatus({ ...baseInput(), maintenanceAccessModes: ['read_only'] }).state).toBe('attention')
  })

  it('reports disruption for unavailable maintenance or failed readiness', () => {
    expect(deriveSystemServiceStatus({ ...baseInput(), maintenanceAccessModes: ['unavailable'] }).state).toBe('disruption')
    expect(deriveSystemServiceStatus({ ...baseInput(), readiness: { ...ready, ready: false, status: 'misconfigured' } }).state).toBe('disruption')
  })

  it('does not claim online while checks are pending or unavailable', () => {
    expect(deriveSystemServiceStatus({ ...baseInput(), readinessPending: true }).state).toBe('attention')
    expect(deriveSystemServiceStatus({ ...baseInput(), maintenanceError: true }).state).toBe('attention')
  })
})
