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

export type SystemServiceIssue = {
  action: string
  impact: string
  service: string
  severity: Exclude<SystemServiceState, 'online'>
  summary: string
}

export type SystemServiceStatus = {
  state: SystemServiceState
  label: 'Online' | 'Attention Needed' | 'Service Disruption'
  detail: string
  issues: SystemServiceIssue[]
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
  const issues: SystemServiceIssue[] = []

  if (!input.configured) {
    issues.push({
      action: 'Redeploy SygShift with its public browser data configuration.',
      impact: 'Sign-in and database-backed workspaces cannot load in this browser release.',
      service: 'Browser data connection',
      severity: 'disruption',
      summary: 'The browser release is missing its public data connection settings.',
    })
  }

  if (input.readinessError) {
    issues.push({
      action: 'Refresh the checks. If this continues, review the active Cloudflare Worker deployment.',
      impact: 'SygShift cannot confirm the health of its protected server configuration.',
      service: 'Production readiness check',
      severity: 'disruption',
      summary: 'The protected production readiness check could not be reached.',
    })
  } else if (input.readiness?.ready === false) {
    const issueCountBeforeReadinessDetails = issues.length
    if (!input.readiness.checks.assetsBinding) {
      issues.push({
        action: 'Restore the Worker assets binding and redeploy the production release.',
        impact: 'Application pages or release assets may not load correctly.',
        service: 'Application delivery',
        severity: 'disruption',
        summary: 'The production Worker cannot access the application asset bundle.',
      })
    }
    if (!input.readiness.checks.supabaseUrl || !input.readiness.checks.supabasePublishableKey) {
      issues.push({
        action: 'Restore the public Supabase URL and publishable key in the Worker configuration.',
        impact: 'Employee authentication and operational records may be unavailable.',
        service: 'Data and authentication',
        severity: 'disruption',
        summary: 'The Worker is missing public data or authentication configuration.',
      })
    }
    if (!input.readiness.checks.supabaseServiceRoleKey) {
      issues.push({
        action: 'Restore the protected Supabase service-role secret in Cloudflare.',
        impact: 'Server-only administrative workflows may be unavailable.',
        service: 'Protected integrations',
        severity: 'disruption',
        summary: 'The Worker is missing a protected administrative integration.',
      })
    }
    if (issues.length === issueCountBeforeReadinessDetails) {
      issues.push({
        action: 'Refresh the checks. If this continues, review the active Worker configuration and logs.',
        impact: 'SygShift cannot confirm that the production release is ready for normal use.',
        service: 'Production readiness check',
        severity: 'disruption',
        summary: 'The protected readiness check reported that the release is not ready.',
      })
    }
  }

  if (input.maintenanceAccessModes.includes('unavailable')) {
    issues.push({
      action: 'Review the active maintenance window in System Operations.',
      impact: 'One or more selected SygShift workflows are temporarily unavailable.',
      service: 'Safe release controls',
      severity: 'disruption',
      summary: 'An active maintenance window has temporarily disabled a selected workflow.',
    })
  } else if (input.maintenanceAccessModes.includes('read_only')) {
    issues.push({
      action: 'Review the active maintenance window in System Operations.',
      impact: 'Affected areas can be viewed but cannot be changed until maintenance ends.',
      service: 'Safe release controls',
      severity: 'attention',
      summary: 'An active maintenance window has placed a selected workflow in read-only mode.',
    })
  } else if (input.maintenanceAccessModes.includes('notice')) {
    issues.push({
      action: 'Review the active maintenance notice in System Operations.',
      impact: 'No access is restricted, but employees may see an operational notice.',
      service: 'Safe release controls',
      severity: 'attention',
      summary: 'A maintenance notice is currently active.',
    })
  }

  if (input.maintenanceError) {
    issues.push({
      action: 'Refresh the checks and confirm the maintenance workspace is reachable.',
      impact: 'SygShift cannot confirm whether any feature-specific maintenance controls are active.',
      service: 'Maintenance controls',
      severity: 'attention',
      summary: 'The maintenance status check could not be completed.',
    })
  }

  if ((input.readinessPending || input.maintenancePending) && issues.length === 0) {
    issues.push({
      action: 'Wait for the protected checks to finish or use Refresh checks.',
      impact: 'No outage has been confirmed while the checks are running.',
      service: 'Service health',
      severity: 'attention',
      summary: 'SygShift is still checking production service health.',
    })
  }

  if (issues.some((issue) => issue.severity === 'disruption')) {
    return {
      detail: issues.map((issue) => issue.summary).join(' '),
      issues,
      label: 'Service Disruption',
      state: 'disruption',
    }
  }

  if (issues.length > 0) {
    return {
      detail: issues.map((issue) => issue.summary).join(' '),
      issues,
      label: 'Attention Needed',
      state: 'attention',
    }
  }

  return {
    detail: 'All SygShift services are operating normally.',
    issues: [],
    label: 'Online',
    state: 'online',
  }
}
