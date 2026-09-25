import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getMyLicensingProfile, upsertLicensingEmployee, type LicensingEmployeeInput } from './licensing'

const supabaseMock = vi.hoisted(() => ({ rpc: vi.fn() }))

vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => ({ rpc: supabaseMock.rpc }),
}))

const credential = {
  credentialId: '10000000-0000-4000-8000-000000000001',
  credentialTypeId: '20000000-0000-4000-8000-000000000001',
  credentialTypeCode: 'standard_guard_license',
  credentialName: 'Standard Guard License',
  category: 'Guard license',
  required: true,
  affectsWorkEligibility: true,
  status: 'Active',
  complianceColor: 'green',
  statusLabel: 'Verified',
  credentialNumber: 'REGRESSION-001',
  issuingAuthority: 'Colorado',
  issueDate: '2026-01-15',
  expirationDate: '2027-01-15',
  daysRemaining: 112,
  renewalStatus: 'not_started',
  employeeNotes: null,
  rejectionReason: null,
  documentCount: 1,
  latestDocumentAt: '2026-09-24T12:00:00.000Z',
  description: 'Required guard credential',
  renewalInstructions: 'Upload the renewed credential.',
  employeeInstructions: 'Upload the complete credential.',
  expirationRequired: true,
}

const profile = {
  serverTimestamp: '2026-09-25T11:40:00.000Z',
  employee: {
    employeeId: '30000000-0000-4000-8000-000000000001',
    employeeNumber: 'SYG-TEST',
    displayName: 'Licensing Regression',
    jobTitle: 'Guard',
    employmentStatus: 'active',
  },
  credentialTypes: [],
  credentials: [credential, {
    ...credential,
    credentialId: '10000000-0000-4000-8000-000000000002',
    credentialTypeId: '20000000-0000-4000-8000-000000000002',
    credentialTypeCode: 'armed_security_guard_credential',
    credentialName: 'Armed Guard License / Endorsement',
  }],
  submissions: [],
  summary: { current: 2, attention: 0, pending: 0, correctionRequired: 0 },
}

describe('employee Licensing profile contract', () => {
  beforeEach(() => supabaseMock.rpc.mockReset())

  it('accepts credentials after the database removes management-only fields', async () => {
    supabaseMock.rpc.mockResolvedValueOnce({ data: profile, error: null })

    const result = await getMyLicensingProfile()

    expect(result.credentials).toHaveLength(2)
    expect(result.credentials[0]).not.toHaveProperty('internalNotes')
    expect(result.credentials[0]).not.toHaveProperty('lastEmployeeNotification')
    expect(supabaseMock.rpc).toHaveBeenCalledWith('get_my_licensing_profile')
  })

  it('strips management-only fields if an upstream payload includes them', async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: {
        ...profile,
        credentials: [{
          ...credential,
          internalNotes: 'Management-only note',
          lastEmployeeNotification: '2026-09-24T12:00:00.000Z',
        }],
        summary: { ...profile.summary, current: 1 },
      },
      error: null,
    })

    const result = await getMyLicensingProfile()

    expect(result.credentials[0]).not.toHaveProperty('internalNotes')
    expect(result.credentials[0]).not.toHaveProperty('lastEmployeeNotification')
  })

  it('returns safe guidance instead of raw validation diagnostics', async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: { ...profile, credentials: [{ ...credential, issueDate: 42 }] },
      error: null,
    })

    await expect(getMyLicensingProfile()).rejects.toThrow(
      'Your licensing information could not be verified. Refresh the page and try again.',
    )
  })
})

describe('Licensing employee time-zone boundary', () => {
  const newEmployee: LicensingEmployeeInput = {
    employmentStatus: 'onboarding',
    employmentType: 'hourly',
    firstName: 'Misty',
    lastName: 'Kimbal',
    role: 'guard',
    timeZone: 'America/New_York',
  }

  beforeEach(() => supabaseMock.rpc.mockReset())

  it('serializes an explicitly confirmed supported zone for a new employee', async () => {
    supabaseMock.rpc.mockResolvedValueOnce({ data: null, error: { message: 'stop after boundary' } })

    await expect(upsertLicensingEmployee(newEmployee)).rejects.toThrow('stop after boundary')

    expect(supabaseMock.rpc).toHaveBeenCalledWith('upsert_licensing_employee', expect.objectContaining({
      target_employee_id: null,
      target_time_zone: 'America/New_York',
    }))
  })

  it.each([
    ['missing', undefined],
    ['unsupported', 'UTC'],
  ])('rejects a %s zone before invoking the employee RPC', async (_label, timeZone) => {
    await expect(upsertLicensingEmployee({
      ...newEmployee,
      timeZone: timeZone as LicensingEmployeeInput['timeZone'],
    })).rejects.toThrow()

    expect(supabaseMock.rpc).not.toHaveBeenCalled()
  })

  it('does not send a replacement zone when editing an existing employee', async () => {
    supabaseMock.rpc.mockResolvedValueOnce({ data: null, error: { message: 'stop after boundary' } })

    await expect(upsertLicensingEmployee({
      ...newEmployee,
      employeeId: '30000000-0000-4000-8000-000000000001',
      timeZone: undefined,
    })).rejects.toThrow('stop after boundary')

    expect(supabaseMock.rpc).toHaveBeenCalledWith('upsert_licensing_employee', expect.objectContaining({
      target_employee_id: '30000000-0000-4000-8000-000000000001',
      target_time_zone: null,
    }))
  })
})
