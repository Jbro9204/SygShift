import { z } from 'zod'
import type { MaintenanceAccessMode } from './maintenance'

const systemReadinessSchema = z.object({
  checks: z.object({
    assetsBinding: z.boolean(),
    supabasePublishableKey: z.boolean(),
    supabaseServiceRoleKey: z.boolean(),
    supabaseUrl: z.boolean(),
  }),
  ready: z.boolean(),
  requestId: z.string(),
  status: z.enum(['ready', 'misconfigured']),
})

export type SystemReadiness = z.infer<typeof systemReadinessSchema>
export type SystemServiceState = 'online' | 'attention' | 'disruption'

export type SystemServiceStatus = {
  state: SystemServiceState
  label: 'Online' | 'Attention Needed' | 'Service Disruption'
  detail: string
}

export async function getSystemReadiness(): Promise<SystemReadiness> {
  const response = await fetch('/api/v1/ready', {
    cache: 'no-store',
    headers: { accept: 'application/json' },
  })
  const payload: unknown = await response.json()
  return systemReadinessSchema.parse(payload)
}

export function deriveSystemServiceStatus(input: {
  configured: boolean
  readiness?: SystemReadiness
  readinessPending: boolean
  readinessError: boolean
  maintenanceAccessModes: MaintenanceAccessMode[]
  maintenancePending: boolean
  maintenanceError: boolean
}): SystemServiceStatus {
  if (
    !input.configured
    || input.readinessError
    || input.readiness?.ready === false
    || input.maintenanceAccessModes.includes('unavailable')
  ) {
    return {
      detail: 'A SygShift service is unavailable. Your work may be affected.',
      label: 'Service Disruption',
      state: 'disruption',
    }
  }

  if (
    input.readinessPending
    || input.maintenancePending
    || input.maintenanceError
    || input.maintenanceAccessModes.some((mode) => mode === 'notice' || mode === 'read_only')
  ) {
    return {
      detail: 'Maintenance or a service advisory may affect part of SygShift.',
      label: 'Attention Needed',
      state: 'attention',
    }
  }

  return {
    detail: 'All SygShift services are operating normally.',
    label: 'Online',
    state: 'online',
  }
}
