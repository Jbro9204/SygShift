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
  })

  it('normalizes raw SVG QR codes into browser-safe image sources', () => {
    const qrCode = normalizeTotpQrCode('<svg><path fill="#000"/></svg>')

    expect(qrCode).toMatch(/^data:image\/svg\+xml;utf-8,/)
    expect(decodeURIComponent(qrCode.split(',')[1])).toBe('<svg><path fill="#000"/></svg>')
  })

  it('clears stale unverified factors before starting a fresh authenticator setup', async () => {
    supabaseMock.client.auth.mfa.listFactors.mockResolvedValue({
      data: {
        totp: [
          { id: 'old-unfinished-factor', status: 'unverified' },
          { id: 'current-verified-factor', status: 'verified' },
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
      friendlyName: 'SygShift',
      issuer: 'SygShift',
    })
    expect(enrollment).toEqual({
      factorId: 'new-factor',
      qrCode: 'data:image/svg+xml;utf-8,%3Csvg%3Enew%20setup%3C%2Fsvg%3E',
      secret: 'NEWSECRET',
    })
  })
})
