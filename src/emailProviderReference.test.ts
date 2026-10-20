import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../worker'

const notificationId = '20000000-0000-4000-8000-000000000001'
const employeeId = '10000000-0000-4000-8000-000000000001'
const recipient = 'employee@example.com'
const opaqueId = '<opaque:provider/id-001>'

function harness(options: { claim?: string, auditUnavailable?: boolean, recipients?: string[] } = {}) {
  let completed = false
  const calls: { name: string, body: Record<string, unknown> }[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const name = String(input).split('/').at(-1) ?? ''
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    calls.push({ name, body })
    let data: unknown = null
    if (name === 'get_session_context') {
      data = { employee_id: employeeId, username: 'admin', display_name: 'Admin User', role: 'admin', has_mfa: true,
        permissions: ['notifications.manage', 'admin.users.invite'] }
    } else if (name === 'get_maintenance_status') {
      data = { active: [], upcoming: [], recentlyCompleted: [], serverTime: new Date().toISOString() }
    } else if (name === 'service_get_employee_login_email_target') {
      data = { employeeId, username: 'employee', authEmail: 'employee@accounts.sygshift.invalid', contactEmail: recipient,
        displayName: 'Example Employee', role: 'guard', employmentType: 'hourly', status: 'active', existingAuthUserId: null }
    } else if (name === (options.claim ?? 'service_claim_timekeeping_notification_batch')) {
      data = completed ? [] : [{ id: notificationId, messageType: 'schedule_published', aggregateType: 'announcement',
        aggregateId: null, recipients: options.recipients ?? [recipient], message: { subject: 'Test update', text: 'Mocked delivery only.' } }]
    } else if (name === 'service_filter_notification_recipients') {
      data = body.target_recipients
    } else if (name.startsWith('service_claim_')) {
      data = []
    } else if (name.startsWith('service_mark_') && name.endsWith('_result') && body.delivered === true) {
      completed = true
    } else if (name === 'service_log_email_delivery' && options.auditUnavailable) {
      return new Response(JSON.stringify({ message: 'Audit storage unavailable.' }), { status: 503, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetch)
  const environment = (send: ReturnType<typeof vi.fn>) => ({
    ASSETS: { fetch: vi.fn() }, EMAIL: { send }, SUPABASE_PUBLISHABLE_KEY: 'publishable', SUPABASE_SERVICE_ROLE_KEY: 'service-role',
    SUPABASE_URL: 'https://example.supabase.co', SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
  }) as unknown as Partial<Env> & { ASSETS: Fetcher }
  const request = (send: ReturnType<typeof vi.fn>, welcome = false) => worker.fetch(new Request(
    welcome ? `https://app.sygshift.example/api/v1/admin/users/${employeeId}/welcome-email` : 'https://app.sygshift.example/api/v1/admin/notifications/process',
    { headers: { authorization: 'Bearer admin-token' }, method: 'POST', body: '{}' },
  ), environment(send))
  return { calls, request }
}

afterEach(() => vi.unstubAllGlobals())

describe('accepted email provider references', () => {
  it.each([
    'service_claim_timekeeping_notification_batch', 'service_claim_time_off_notification_batch', 'service_claim_notification_batch',
    'service_claim_support_ticket_notification_batch', 'service_claim_employee_notification_batch',
  ])('retains the exact opaque ID for each normalized recipient in %s', async (claim) => {
    const { calls, request } = harness({ claim, recipients: [' Employee@Example.com ', 'second@example.com', recipient] })
    const send = vi.fn().mockResolvedValueOnce({ messageId: opaqueId }).mockResolvedValueOnce({ messageId: 'second-id' })
    const response = await request(send)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ delivered: [notificationId], failed: [], processed: 1 })
    expect(send).toHaveBeenCalledTimes(2)
    expect(calls.filter((call) => call.name === 'service_log_email_delivery').map((call) => call.body)).toEqual([
      expect.objectContaining({ target_delivery_status: 'sent', target_intended_recipient: recipient, target_provider_reference: opaqueId, target_failure_detail: null }),
      expect.objectContaining({ target_delivery_status: 'sent', target_intended_recipient: 'second@example.com', target_provider_reference: 'second-id', target_failure_detail: null }),
    ])
  })

  it('records inline acceptance IDs without exposing internal provider metadata in the welcome API', async () => {
    const { calls, request } = harness()
    const send = vi.fn().mockResolvedValue({ messageId: opaqueId })
    const response = await request(send, true)
    expect(response.status).toBe(200)
    const payload = await response.json() as { delivery: Record<string, unknown> }
    expect(payload.delivery).toEqual({ sent: [recipient], failed: [], suppressed: [] })
    expect(JSON.stringify(payload)).not.toContain(opaqueId)
    expect(calls.find((call) => call.name === 'service_log_email_delivery')?.body).toMatchObject({ target_provider_reference: opaqueId, target_delivery_status: 'sent' })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('keeps inline provider acceptance successful when the audit write fails, without issuing another send or failure audit', async () => {
    const { calls, request } = harness({ auditUnavailable: true })
    const send = vi.fn().mockResolvedValue({ messageId: opaqueId })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const response = await request(send, true)
      expect(response.status).toBe(200)
      const result = await response.json() as { delivery: Record<string, unknown> }
      expect(result.delivery).toEqual({ sent: [recipient], failed: [], suppressed: [] })
      expect(send).toHaveBeenCalledTimes(1)
      expect(calls.filter((call) => call.name === 'service_log_email_delivery')).toHaveLength(1)
      expect(calls.find((call) => call.name === 'service_log_email_delivery')?.body).toMatchObject({ target_delivery_status: 'sent', target_provider_reference: opaqueId })
      expect(error).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: 'email_delivery_audit_deferred', notificationType: 'welcome_email' }))
      expect(JSON.stringify(error.mock.calls)).not.toContain(recipient)
      expect(JSON.stringify(error.mock.calls)).not.toContain(opaqueId)
    } finally { error.mockRestore() }
  })

  it('makes queued acceptance durable before a failed ID audit so the next cycle cannot resend', async () => {
    const { calls, request } = harness({ auditUnavailable: true })
    const send = vi.fn().mockResolvedValue({ messageId: opaqueId })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const first = await request(send)
      expect(await first.json()).toMatchObject({ delivered: [notificationId], failed: [], processed: 1 })
      const second = await request(send)
      expect(await second.json()).toMatchObject({ delivered: [], failed: [], processed: 0 })
      expect(send).toHaveBeenCalledTimes(1)
      const mark = calls.findIndex((call) => call.name === 'service_mark_notification_result' && call.body.delivered === true)
      const audit = calls.findIndex((call) => call.name === 'service_log_email_delivery')
      expect(mark).toBeGreaterThanOrEqual(0)
      expect(mark).toBeLessThan(audit)
      expect(calls[audit].body).toMatchObject({ target_provider_reference: opaqueId, target_delivery_status: 'sent' })
      expect(calls.some((call) => call.name === 'service_mark_notification_result' && call.body.delivered === false)).toBe(false)
      expect(JSON.stringify(error.mock.calls)).not.toContain(recipient)
    } finally { error.mockRestore() }
  })

  it.each([undefined, {}, { messageId: 42 }, { messageId: '' }])('does not invent an ID when acceptance has no documented nonempty string: %j', async (acceptance) => {
    const { calls, request } = harness()
    const response = await request(vi.fn().mockResolvedValue(acceptance))
    expect(await response.json()).toMatchObject({ delivered: [notificationId], failed: [] })
    expect(calls.find((call) => call.name === 'service_log_email_delivery')?.body.target_provider_reference).toBeNull()
  })

  it('never attaches an accepted ID to a provider rejection', async () => {
    const { calls, request } = harness()
    const send = vi.fn().mockRejectedValue(Object.assign(new Error('Recipient suppressed.'), { code: 'E_RECIPIENT_SUPPRESSED', messageId: 'untrusted-rejection-id' }))
    await request(send)
    expect(calls.find((call) => call.name === 'service_log_email_delivery')?.body).toMatchObject({
      target_provider_reference: null, target_delivery_status: 'suppressed_provider_recipient',
    })
  })
})
