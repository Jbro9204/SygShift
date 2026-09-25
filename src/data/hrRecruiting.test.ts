import { beforeEach, describe, expect, it, vi } from 'vitest'
import { requestCandidateConversion } from './hrRecruiting'

const documentApiRequest = vi.hoisted(() => vi.fn())

vi.mock('./hrDocuments', () => ({
  documentApiRequest,
  parseApiError: vi.fn(),
}))

const conversion = {
  applicationId: '10000000-0000-4000-8000-000000000001',
  employmentType: 'hourly',
  jobTitle: 'Guard',
  reason: 'Approved hiring plan.',
  role: 'guard',
  startDate: '2026-09-28',
  timeZone: 'America/New_York' as const,
}

describe('candidate conversion employee time zone', () => {
  beforeEach(() => documentApiRequest.mockReset())

  it('serializes the explicitly confirmed zone for the conversion request', async () => {
    documentApiRequest.mockResolvedValueOnce(new Response(JSON.stringify({
      conversionRequestId: '10000000-0000-4000-8000-000000000002',
      status: 'requested',
    }), { status: 201 }))

    await requestCandidateConversion(conversion)

    expect(documentApiRequest).toHaveBeenCalledWith('/api/v1/hr/recruiting/conversions', expect.objectContaining({
      body: expect.stringContaining('"timeZone":"America/New_York"'),
    }))
  })

  it('rejects a blank or unsupported zone before the request is sent', async () => {
    await expect(requestCandidateConversion({ ...conversion, timeZone: '' as typeof conversion.timeZone })).rejects.toThrow()
    await expect(requestCandidateConversion({ ...conversion, timeZone: 'UTC' as typeof conversion.timeZone })).rejects.toThrow()
    expect(documentApiRequest).not.toHaveBeenCalled()
  })
})
