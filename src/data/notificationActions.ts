import { safeNotificationPath } from './liveNotifications'
import {
  parseSygilantPlatformDestination,
  type SygilantPlatformDestination,
} from './platformLaunch'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const sygilantDispatchSourceTypes = new Set([
  'sygilant_dispatch_assignment',
  'sygilant_dispatch_call',
  'sygilant_dispatch_escalation',
])
const sygilantIncidentReportSourceTypes = new Set([
  'sygilant_incident_report_completion',
  'sygilant_incident_report_ownership',
])
const sygilantReportSourceTypes = new Set(['sygilant_report', 'sygilant_report_correction'])

export type NotificationAction =
  | { kind: 'local'; path: string }
  | { destination: SygilantPlatformDestination; kind: 'sygilant' }
  | { kind: 'none' }

export type NotificationActionReference = {
  actionPath: string | null
  sourceId: string | null
  sourceType: string
}

export function resolveNotificationAction(reference: NotificationActionReference): NotificationAction {
  const crossPlatformCandidate = sygilantDispatchSourceTypes.has(reference.sourceType)
    || sygilantIncidentReportSourceTypes.has(reference.sourceType)
    || sygilantReportSourceTypes.has(reference.sourceType)
    || reference.actionPath?.startsWith('/dispatch') === true
    || reference.actionPath?.startsWith('/daily-activity-reports') === true
    || reference.actionPath?.startsWith('/incident-reports') === true
    || reference.actionPath?.startsWith('/vehicle-inspections') === true

  if (crossPlatformCandidate) {
    const destination = parseSygilantPlatformDestination(reference.actionPath)
    if (
      destination?.startsWith('/dispatch?call=')
      && reference.sourceId
      && uuidPattern.test(reference.sourceId)
      && destination === `/dispatch?call=${reference.sourceId}`
      && sygilantDispatchSourceTypes.has(reference.sourceType)
    ) {
      return { destination, kind: 'sygilant' }
    }
    if (
      destination?.includes('?report=')
      && reference.sourceId
      && uuidPattern.test(reference.sourceId)
      && (
        (
          sygilantIncidentReportSourceTypes.has(reference.sourceType)
          && destination === `/incident-reports?report=${reference.sourceId}`
        )
        || (
          reference.sourceType === 'sygilant_report'
          && destination.endsWith(`?report=${reference.sourceId}`)
        )
        || reference.sourceType === 'sygilant_report_correction'
      )
    ) {
      return { destination, kind: 'sygilant' }
    }
    return { kind: 'none' }
  }

  return reference.actionPath
    ? { kind: 'local', path: safeNotificationPath(reference.actionPath) }
    : { kind: 'none' }
}
