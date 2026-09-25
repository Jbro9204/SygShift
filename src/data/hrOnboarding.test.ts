import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHrOnboardingPrehire, onboardingEmploymentStepReady, suggestedEmployeeTimeZone, type HrOnboardingPrehireInput } from './hrOnboarding'

const documentApiRequest = vi.hoisted(() => vi.fn())

vi.mock('./hrDocuments', () => ({
  documentApiRequest,
  parseApiError: vi.fn(),
}))

const input: HrOnboardingPrehireInput = {
  employmentType: 'hourly',
  firstName: 'Sample',
  jobFamily: 'guard',
  lastName: 'Employee',
  personalEmail: 'sample@example.com',
  positionTitle: 'Guard',
  requiresArmedCredentials: false,
  requiresGuardLicense: true,
  role: 'guard',
  startDate: '2026-09-28',
  timeZone: 'America/New_York',
  workState: 'CO',
}

describe('HR onboarding employee time zone', () => {
  beforeEach(() => documentApiRequest.mockReset())

  it('suggests Eastern for North Carolina without changing the required confirmation value', () => {
    expect(suggestedEmployeeTimeZone('NC')).toBe('America/New_York')
    expect(input.timeZone).toBe('America/New_York')
  })

  it('suggests non-DST Arizona time for Arizona employees', () => {
    expect(suggestedEmployeeTimeZone('AZ')).toBe('America/Phoenix')
  })

  it('lets existing-employee onboarding advance without replacing the stored profile zone', () => {
    const employment = { positionTitle: 'Guard', startDate: '2026-09-28', timeZone: '' }
    expect(onboardingEmploymentStepReady(employment, false)).toBe(true)
    expect(onboardingEmploymentStepReady(employment, true)).toBe(false)
  })

  it('sends the explicitly confirmed supported time zone', async () => {
    documentApiRequest.mockResolvedValueOnce(new Response(JSON.stringify({
      action: 'create_prehire',
      caseId: '10000000-0000-4000-8000-000000000001',
      id: '10000000-0000-4000-8000-000000000002',
    }), { status: 201 }))

    await createHrOnboardingPrehire(input, 'Create employee onboarding record.')

    expect(documentApiRequest).toHaveBeenCalledWith('/api/v1/hr/onboarding/prehires', expect.objectContaining({
      body: expect.stringContaining('"timeZone":"America/New_York"'),
    }))
  })

  it('rejects a missing or unsupported time zone before the request is sent', async () => {
    await expect(createHrOnboardingPrehire({ ...input, timeZone: '' as HrOnboardingPrehireInput['timeZone'] }, 'Create employee onboarding record.')).rejects.toThrow()
    await expect(createHrOnboardingPrehire({ ...input, timeZone: 'UTC' as HrOnboardingPrehireInput['timeZone'] }, 'Create employee onboarding record.')).rejects.toThrow()
    expect(documentApiRequest).not.toHaveBeenCalled()
  })
})
