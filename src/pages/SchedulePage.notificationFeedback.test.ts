import { describe, expect, it } from 'vitest'
import { scheduleNotificationFeedback } from '../schedule/notificationFeedback'

const weekLabel = '10/18/2026 - 10/24/2026'

function result({
  accepted = 0,
  completionPending = 0,
  id = '10000000-0000-4000-8000-000000000001',
  processed = 1,
  status = 'delivered' as 'delivered' | 'failed' | 'pending' | 'suppressed',
  suppressed = 0,
  uncertain = 0,
  total = accepted + completionPending + suppressed + uncertain,
}: {
  accepted?: number
  completionPending?: number
  id?: string
  processed?: number
  status?: 'delivered' | 'failed' | 'pending' | 'suppressed'
  suppressed?: number
  total?: number
  uncertain?: number
}) {
  return {
    outcomes: processed === 0 ? [] : [{
      id,
      recipients: { accepted, completionPending, suppressed, total, uncertain },
      status,
    }],
    processed,
  }
}

const notificationId = '10000000-0000-4000-8000-000000000001'

describe('schedule notification delivery feedback', () => {
  it('separates the in-app schedule state from a zero-attempt email result', () => {
    const message = scheduleNotificationFeedback(weekLabel, notificationId, result({ processed: 0 }))

    expect(message).toBe('The published schedule for 10/18/2026 - 10/24/2026 remains available in SygShift. The exact email notice was not ready for delivery; no delivery was claimed.')
    expect(message).not.toMatch(/notification sent/i)
  })

  it('reports an all-failed email result without claiming the notification was sent', () => {
    const message = scheduleNotificationFeedback(weekLabel, notificationId, result({ status: 'failed', total: 3 }))

    expect(message).toContain('Email delivery failed for the targeted notice covering 3 recipients.')
    expect(message).not.toMatch(/notification sent/i)
  })

  it('reports accepted and suppressed recipient counts from the exact notice', () => {
    expect(scheduleNotificationFeedback(weekLabel, notificationId, result({ accepted: 2, suppressed: 1 })))
      .toContain('Email was accepted for 2 recipients; 1 recipient was suppressed.')
  })

  it('reports fully accepted email', () => {
    expect(scheduleNotificationFeedback(weekLabel, notificationId, result({ accepted: 2 })))
      .toContain('Email was accepted for all 2 recipients.')
  })

  it('does not invent delivery for uncertain provider outcomes', () => {
    expect(scheduleNotificationFeedback(weekLabel, notificationId, result({ accepted: 1, status: 'pending', uncertain: 1 })))
      .toContain('1 recipient was accepted by the email provider; 1 recipient requires delivery reconciliation')
  })

  it('does not report unrelated batch outcomes as this schedule notice', () => {
    expect(scheduleNotificationFeedback(weekLabel, notificationId, result({
      accepted: 4,
      id: '20000000-0000-4000-8000-000000000002',
    }))).toContain("exact email notice's delivery result could not be verified")
  })
})
