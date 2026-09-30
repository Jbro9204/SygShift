import { beforeEach, describe, expect, it, vi } from 'vitest'
import { documentApiRequest } from './hrDocuments'
import { getUserAccountActivityReport, type UserAccountActivityFilters } from './userAccountActivityReport'
import { userAccountActivityReportFixture } from '../test/userAccountActivityFixtures'

vi.mock('./hrDocuments', () => ({ documentApiRequest: vi.fn(), parseApiError: vi.fn() }))

const filters: UserAccountActivityFilters = {
  search: '', employmentStatus: '', accountStatus: '', loginStatus: '', mfaStatus: '', role: '', source: '', staleDays: 30,
}

beforeEach(() => {
  vi.mocked(documentApiRequest).mockReset().mockImplementation(async () => new Response(JSON.stringify(userAccountActivityReportFixture())))
})

describe('User Account Activity data contract', () => {
  it('retains authoritative role options when parsing the protected report', async () => {
    const result = await getUserAccountActivityReport(filters)
    expect(result.roleOptions).toEqual(userAccountActivityReportFixture().roleOptions)
  })

  it.each(['guard', 'recruiting_licensing', 'Chief', 'Human Resources Manager', 'Audit & QA'])('preserves the existing %s filter value in report and export requests', async (role) => {
    for (const exportRequested of [false, true]) {
      await getUserAccountActivityReport({ ...filters, role, export: exportRequested })
      const url = new URL(String(vi.mocked(documentApiRequest).mock.lastCall?.[0]), 'https://test.example')
      expect(url.searchParams.get('role')).toBe(role)
      expect(url.searchParams.get('export')).toBe(exportRequested ? 'true' : null)
    }
  })

  it('continues to parse existing report/export payloads during a rolling update', async () => {
    vi.mocked(documentApiRequest).mockResolvedValue(new Response(JSON.stringify(userAccountActivityReportFixture({ roleOptions: undefined }))))
    expect((await getUserAccountActivityReport(filters)).rows).toEqual([])
  })
})
