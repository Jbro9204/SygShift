import { describe, expect, it } from 'vitest'
import { deriveSystemServiceStatus, type SystemReadiness } from './systemStatus'

const ready: SystemReadiness = {
  checks: {
    assetsBinding: true,
    scheduledRuntimeCoordinator: true,
    scheduledRuntimeFresh: true,
    scheduledRuntimeSourceCommit: true,
    supabasePublishableKey: true,
    supabaseServiceRoleKey: true,
    supabaseUrl: true,
  },
  ready: true,
  requestId: 'request-id',
  scheduledRuntime: {
    consecutiveFailures: 0,
    lastFullSuccessAt: '2026-10-19T15:00:00.000Z',
    lastFullSuccessSourceCommit: 'a'.repeat(40),
    lastSuccessAt: '2026-10-19T15:00:00.000Z',
    mode: 'closed',
    nextProbeAt: null,
  },
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
    expect(deriveSystemServiceStatus(baseInput())).toMatchObject({ issues: [], state: 'online' })
  })

  it('reports attention for an active notice or read-only maintenance window', () => {
    expect(deriveSystemServiceStatus({ ...baseInput(), maintenanceAccessModes: ['notice'] }).state).toBe('attention')
    expect(deriveSystemServiceStatus({ ...baseInput(), maintenanceAccessModes: ['read_only'] }).state).toBe('attention')
  })

  it('reports disruption for unavailable maintenance or failed readiness', () => {
    expect(deriveSystemServiceStatus({ ...baseInput(), maintenanceAccessModes: ['unavailable'] }).state).toBe('disruption')
    expect(deriveSystemServiceStatus({ ...baseInput(), readiness: { ...ready, ready: false, status: 'misconfigured' } }).state).toBe('disruption')
  })

  it('identifies the exact service and recovery action for a blank browser release configuration', () => {
    const status = deriveSystemServiceStatus({ ...baseInput(), configured: false })

    expect(status.state).toBe('disruption')
    expect(status.issues).toContainEqual(expect.objectContaining({
      service: 'Browser data connection',
      severity: 'disruption',
    }))
    expect(status.issues[0]?.action).toContain('Redeploy')
  })

  it('identifies each failed protected readiness component', () => {
    const status = deriveSystemServiceStatus({
      ...baseInput(),
      readiness: {
        ...ready,
        checks: {
          assetsBinding: true,
          scheduledRuntimeCoordinator: true,
          scheduledRuntimeFresh: true,
          scheduledRuntimeSourceCommit: true,
          supabasePublishableKey: true,
          supabaseServiceRoleKey: false,
          supabaseUrl: true,
        },
        ready: false,
        status: 'misconfigured',
      },
    })

    expect(status.issues).toHaveLength(1)
    expect(status.issues[0]?.service).toBe('Protected integrations')
  })

  it('does not claim online while checks are pending or unavailable', () => {
    expect(deriveSystemServiceStatus({ ...baseInput(), readinessPending: true }).state).toBe('attention')
    expect(deriveSystemServiceStatus({ ...baseInput(), maintenanceError: true }).state).toBe('attention')
  })

  it('explains automatic containment and verified recovery without implying data changes', () => {
    const status = deriveSystemServiceStatus({
      ...baseInput(),
      readiness: {
        ...ready,
        checks: { ...ready.checks, scheduledRuntimeFresh: false },
        ready: false,
        scheduledRuntime: {
          consecutiveFailures: 2,
          lastFullSuccessAt: '2026-10-19T14:00:00.000Z',
          lastFullSuccessSourceCommit: 'a'.repeat(40),
          lastSuccessAt: '2026-10-19T14:00:00.000Z',
          mode: 'recovering',
          nextProbeAt: '2026-10-19T15:01:00.000Z',
        },
        status: 'degraded',
      },
    })

    expect(status.state).toBe('disruption')
    expect(status.issues).toContainEqual(expect.objectContaining({
      action: expect.stringContaining('later cycle'),
      impact: expect.stringContaining('read-only recovery check'),
      service: 'Data service recovery',
    }))
    expect(status.detail).toContain('verifying data-service recovery')
  })

  it('does not mislabel a stale closed scheduler as an active data-service outage', () => {
    const status = deriveSystemServiceStatus({
      ...baseInput(),
      readiness: {
        ...ready,
        checks: { ...ready.checks, scheduledRuntimeFresh: false },
        ready: false,
        scheduledRuntime: {
          consecutiveFailures: 0,
          lastFullSuccessAt: null,
          lastFullSuccessSourceCommit: null,
          lastSuccessAt: null,
          mode: 'closed',
          nextProbeAt: null,
        },
        status: 'degraded',
      },
    })

    expect(status.issues).toContainEqual(expect.objectContaining({
      impact: expect.stringContaining('no data-service outage has been confirmed'),
      summary: 'Scheduled runtime health confirmation is stale.',
    }))
    expect(status.detail).not.toContain('data service is unavailable')
  })

  it('explains that open-circuit probes retry once per minute without changing records', () => {
    const status = deriveSystemServiceStatus({
      ...baseInput(),
      readiness: {
        ...ready,
        checks: { ...ready.checks, scheduledRuntimeFresh: false },
        ready: false,
        scheduledRuntime: {
          consecutiveFailures: 1,
          lastFullSuccessAt: '2026-10-19T14:00:00.000Z',
          lastFullSuccessSourceCommit: 'a'.repeat(40),
          lastSuccessAt: '2026-10-19T14:00:00.000Z',
          mode: 'open',
          nextProbeAt: '2026-10-19T15:01:00.000Z',
        },
        status: 'degraded',
      },
    })

    expect(status.issues).toContainEqual(expect.objectContaining({
      action: expect.stringContaining('once per minute'),
      impact: expect.stringContaining('scheduled record changes remain paused'),
    }))
  })
})
