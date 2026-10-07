import { describe, expect, it } from 'vitest'
import { resolveNotificationAction } from './notificationActions'

const callId = '4896f7c0-7143-48f9-9978-d1f6a342186f'
const reportId = 'eacdc293-e7ff-4d14-8f8e-38340e26a2c5'

describe('notification action routing', () => {
  it.each([
    'sygilant_dispatch_assignment',
    'sygilant_dispatch_call',
    'sygilant_dispatch_escalation',
  ])('opens %s through the signed Sygilant handoff', (sourceType) => {
    expect(resolveNotificationAction({
      actionPath: `/dispatch?call=${callId}`,
      sourceId: callId,
      sourceType,
    })).toEqual({ destination: `/dispatch?call=${callId}`, kind: 'sygilant' })
  })

  it('keeps ordinary SygShift actions local', () => {
    expect(resolveNotificationAction({
      actionPath: '/support?ticket=123',
      sourceId: null,
      sourceType: 'support_ticket',
    })).toEqual({ kind: 'local', path: '/support?ticket=123' })
  })

  it.each([
    'sygilant_incident_report_completion',
    'sygilant_incident_report_ownership',
    'sygilant_report',
  ])('opens %s only when its source id matches the incident report', (sourceType) => {
    expect(resolveNotificationAction({
      actionPath: `/incident-reports?report=${reportId}`,
      sourceId: reportId,
      sourceType,
    })).toEqual({ destination: `/incident-reports?report=${reportId}`, kind: 'sygilant' })
    expect(resolveNotificationAction({
      actionPath: `/incident-reports?report=${reportId}`,
      sourceId: callId,
      sourceType,
    })).toEqual({ kind: 'none' })
  })

  it('accepts a correction source id separately from its exact incident report destination', () => {
    expect(resolveNotificationAction({
      actionPath: `/incident-reports?report=${reportId}`,
      sourceId: callId,
      sourceType: 'sygilant_report_correction',
    })).toEqual({ destination: `/incident-reports?report=${reportId}`, kind: 'sygilant' })
  })

  it.each([
    '/daily-activity-reports',
    '/incident-reports',
    '/vehicle-inspections',
  ] as const)('preserves exact %s report actions for report and correction notifications', (path) => {
    const destination = `${path}?report=${reportId}` as const
    expect(resolveNotificationAction({
      actionPath: destination,
      sourceId: reportId,
      sourceType: 'sygilant_report',
    })).toEqual({ destination, kind: 'sygilant' })
    expect(resolveNotificationAction({
      actionPath: destination,
      sourceId: callId,
      sourceType: 'sygilant_report_correction',
    })).toEqual({ destination, kind: 'sygilant' })
  })

  it.each([
    { actionPath: `/dispatch?call=${callId}&admin=true`, sourceId: callId, sourceType: 'sygilant_dispatch_call' },
    { actionPath: `/dispatch?call=${callId}`, sourceId: crypto.randomUUID(), sourceType: 'sygilant_dispatch_call' },
    { actionPath: `/dispatch?call=${callId}`, sourceId: callId, sourceType: 'direct' },
    { actionPath: '//sygilant.us/dispatch', sourceId: callId, sourceType: 'sygilant_dispatch_call' },
    { actionPath: `/incident-reports?report=${reportId}&edit=true`, sourceId: reportId, sourceType: 'sygilant_report' },
    { actionPath: `/incident-reports?report=${reportId}`, sourceId: reportId, sourceType: 'direct' },
    { actionPath: `/daily-activity-reports?report=${reportId}&edit=true`, sourceId: reportId, sourceType: 'sygilant_report' },
    { actionPath: `/vehicle-inspections?report=${reportId}`, sourceId: callId, sourceType: 'sygilant_report' },
  ])('fails closed for an unbound cross-platform action', (reference) => {
    expect(resolveNotificationAction(reference)).toEqual({ kind: 'none' })
  })
})
