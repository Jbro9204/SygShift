import { beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeTotpQrCode, startTotpEnrollment } from './mfa'

const supabaseMock = vi.hoisted(() => ({
  client: {
    auth: {
      mfa: {
        enroll: vi.fn(),
        listFactors: vi.fn(),
        unenroll: vi.fn(),
      },
    },
  },
}))

vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => supabaseMock.client,
}))

describe('MFA enrollment helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('normalizes raw SVG QR codes into browser-safe image sources', () => {
    const qrCode = normalizeTotpQrCode('<svg><path fill="#000"/></svg>')

    expect(qrCode).toMatch(/^data:image\/svg\+xml;utf-8,/)
    expect(decodeURIComponent(qrCode.split(',')[1])).toBe('<svg><path fill="#000"/></svg>')
  })

  it('clears stale unverified factors before starting a fresh authenticator setup', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-05T21:30:15.000Z'))
    supabaseMock.client.auth.mfa.listFactors.mockResolvedValue({
      data: {
        totp: [
          { id: 'old-unfinished-factor', status: 'unverified' },
          { id: 'current-verified-factor', status: 'verified' },
        ],
        all: [
          { id: 'old-unfinished-factor', factor_type: 'totp', status: 'unverified' },
          { id: 'current-verified-factor', factor_type: 'totp', status: 'verified' },
          { id: 'phone-factor', factor_type: 'phone', status: 'unverified' },
        ],
      },
      error: null,
    })
    supabaseMock.client.auth.mfa.unenroll.mockResolvedValue({ data: {}, error: null })
    supabaseMock.client.auth.mfa.enroll.mockResolvedValue({
      data: {
        id: 'new-factor',
        totp: {
          qr_code: '<svg>new setup</svg>',
          secret: 'NEWSECRET',
        },
      },
      error: null,
    })

    const enrollment = await startTotpEnrollment()

    expect(supabaseMock.client.auth.mfa.unenroll).toHaveBeenCalledTimes(1)
    expect(supabaseMock.client.auth.mfa.unenroll).toHaveBeenCalledWith({ factorId: 'old-unfinished-factor' })
    expect(supabaseMock.client.auth.mfa.enroll).toHaveBeenCalledWith({
      factorType: 'totp',
      friendlyName: 'SygShift 20260705213015',
      issuer: 'SygShift',
    })
    expect(enrollment).toEqual({
      factorId: 'new-factor',
      qrCode: 'data:image/svg+xml;utf-8,%3Csvg%3Enew%20setup%3C%2Fsvg%3E',
      secret: 'NEWSECRET',
    })
  })

  it('retries authenticator setup with a fresh friendly name when Supabase reports a name collision', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-05T21:35:40.000Z'))
    supabaseMock.client.auth.mfa.listFactors.mockResolvedValue({
      data: { totp: [], all: [] },
      error: null,
    })
    supabaseMock.client.auth.mfa.enroll
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'A factor with the friendly name "SygShift" for this user already exists' },
      })
      .mockResolvedValueOnce({
        data: {
          id: 'retry-factor',
          totp: {
            qr_code: '<svg>retry setup</svg>',
            secret: 'RETRYSECRET',
          },
        },
        error: null,
      })

    const enrollment = await startTotpEnrollment()

    expect(supabaseMock.client.auth.mfa.enroll).toHaveBeenCalledTimes(2)
    expect(supabaseMock.client.auth.mfa.enroll).toHaveBeenNthCalledWith(1, {
      factorType: 'totp',
      friendlyName: 'SygShift 20260705213540',
      issuer: 'SygShift',
    })
    expect(supabaseMock.client.auth.mfa.enroll).toHaveBeenNthCalledWith(2, {
      factorType: 'totp',
      friendlyName: 'SygShift 20260705213540-2',
      issuer: 'SygShift',
    })
    expect(enrollment.factorId).toBe('retry-factor')
  })
})
