import { describe, expect, it, vi } from 'vitest'
import worker from '../worker'
import { emailDeliveryFailure } from '../worker/emailDeliveryFailure'

const notificationId = '20000000-0000-4000-8000-000000000001'
const recipient = 'employee@example.com'

function notificationEnvironment(send: ReturnType<typeof vi.fn>) {
  return {
    ASSETS: { fetch: vi.fn() },
    EMAIL: { send },
    SUPABASE_PUBLISHABLE_KEY: 'publishable',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role',
    SUPABASE_URL: 'https://example.supabase.co',
    SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
  } as unknown as Partial<Env> & { ASSETS: Fetcher }
}

function notificationRpc(claim: string, recipients = [recipient]) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const name = String(input).split('/').at(-1)
    let payload: unknown = null
    if (name === 'get_session_context') {
      payload = {
        employee_id: '10000000-0000-4000-8000-000000000001', username: 'admin',
        display_name: 'Admin User', role: 'admin', has_mfa: true,
        permissions: ['notifications.manage'],
      }
    } else if (name === 'get_maintenance_status') {
      payload = { active: [], upcoming: [], recentlyCompleted: [], serverTime: new Date().toISOString() }
    } else if (name === claim) {
      payload = [{
        id: notificationId, recipients, messageType: 'automatic_clock_out_employee',
        message: { subject: 'Timekeeping update', text: 'Review your time entry.' },
      }]
    } else if (name === 'service_filter_notification_recipients') {
      payload = recipients
    } else if (name?.startsWith('service_claim_')) {
      payload = []
    }
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
  })
}

async function processNotifications(send: ReturnType<typeof vi.fn>) {
  return worker.fetch(new Request('https://app.sygshift.example/api/v1/admin/notifications/process', {
    headers: { authorization: 'Bearer admin-token' }, method: 'POST',
  }), notificationEnvironment(send))
}

describe('provider email suppression', () => {
  it('preserves structured provider codes in audit detail', () => {
    expect(emailDeliveryFailure(Object.assign(new Error('Recipient is suppressed.'), {
      code: 'E_RECIPIENT_SUPPRESSED',
    }))).toEqual({ code: 'E_RECIPIENT_SUPPRESSED', detail: 'E_RECIPIENT_SUPPRESSED: Recipient is suppressed.' })
    expect(emailDeliveryFailure({ code: 'E_RATE_LIMIT_EXCEEDED', message: 'Retry later.' }))
      .toEqual({ code: 'E_RATE_LIMIT_EXCEEDED', detail: 'E_RATE_LIMIT_EXCEEDED: Retry later.' })
    expect(emailDeliveryFailure('E_RECIPIENT_SUPPRESSED')).toEqual({ code: undefined, detail: 'Email delivery failed.' })
  })

  it.each([
    ['service_claim_timekeeping_notification_batch', 'service_mark_notification_suppressed', 'target_notification_id'],
    ['service_claim_time_off_notification_batch', 'service_mark_notification_suppressed', 'target_notification_id'],
    ['service_claim_notification_batch', 'service_mark_notification_suppressed', 'target_notification_id'],
    ['service_claim_support_ticket_notification_batch', 'service_mark_support_ticket_notification_suppressed', 'target_notification_id'],
    ['service_claim_employee_notification_batch', 'service_mark_employee_notification_suppressed', 'target_delivery_id'],
  ])('terminally suppresses provider-rejected mail from %s', async (claim, marker, idKey) => {
    const rpc = notificationRpc(claim)
    const send = vi.fn().mockRejectedValue(Object.assign(new Error('Recipient is suppressed.'), {
      code: 'E_RECIPIENT_SUPPRESSED',
    }))
    vi.stubGlobal('fetch', rpc)
    try {
      const response = await processNotifications(send)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ delivered: [], failed: [], processed: 1, suppressed: [notificationId] })
      expect(send).toHaveBeenCalledTimes(1)
      const calls = rpc.mock.calls.map(([input, init]) => ({ name: String(input).split('/').at(-1), body: JSON.parse(String(init?.body)) }))
      expect(calls).toContainEqual({ name: marker, body: {
        [idKey]: notificationId, target_reason: 'Suppressed — Provider Recipient',
      } })
      expect(calls.some((call) => call.name?.startsWith('service_mark_') && call.name.endsWith('_result'))).toBe(false)
      expect(calls).toContainEqual(expect.objectContaining({ name: 'service_log_email_delivery', body: expect.objectContaining({
        target_delivery_status: 'suppressed_provider_recipient', target_failure_detail: 'E_RECIPIENT_SUPPRESSED: Recipient is suppressed.',
      }) }))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it.each([
    new Error('E_RECIPIENT_SUPPRESSED'),
    Object.assign(new Error('Retry later.'), { code: 'E_RATE_LIMIT_EXCEEDED' }),
  ])('keeps unconfirmed suppression and transient provider failures retryable', async (error) => {
    const rpc = notificationRpc('service_claim_timekeeping_notification_batch')
    vi.stubGlobal('fetch', rpc)
    try {
      const response = await processNotifications(vi.fn().mockRejectedValue(error))
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ delivered: [], failed: [{ id: notificationId }], suppressed: [] })
      const calls = rpc.mock.calls.map(([input]) => String(input).split('/').at(-1))
      expect(calls).toContain('service_mark_notification_result')
      expect(calls).not.toContain('service_mark_notification_suppressed')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('completes accepted mail without retrying its permanently suppressed co-recipient', async () => {
    const rpc = notificationRpc('service_claim_timekeeping_notification_batch', [recipient, 'suppressed@example.com'])
    const send = vi.fn().mockResolvedValueOnce({ messageId: 'accepted' }).mockRejectedValueOnce(
      Object.assign(new Error('Recipient is suppressed.'), { code: 'E_RECIPIENT_SUPPRESSED' }),
    )
    vi.stubGlobal('fetch', rpc)
    try {
      const response = await processNotifications(send)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ delivered: [notificationId], failed: [], suppressed: [], processed: 1 })
      expect(send).toHaveBeenCalledTimes(2)
      const calls = rpc.mock.calls.map(([input, init]) => ({ name: String(input).split('/').at(-1), body: JSON.parse(String(init?.body)) }))
      expect(calls).toContainEqual({ name: 'service_mark_notification_result', body: {
        target_notification_id: notificationId, delivered: true, delivery_error: null,
      } })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
