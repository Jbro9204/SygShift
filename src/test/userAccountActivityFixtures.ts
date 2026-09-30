import type { UserAccountActivityReport } from '../data/userAccountActivityReport'

export function userAccountActivityReportFixture(overrides: Partial<UserAccountActivityReport> = {}): UserAccountActivityReport {
  return {
    serverTimestamp: '2026-09-30T16:00:00Z',
    staleDays: 30,
    pageSize: 25,
    offset: 0,
    totalCount: 0,
    summary: { total: 0, activeAccounts: 0, neverSignedIn: 0, pendingSetup: 0, mfaAttention: 0, disabled: 0, securityExceptions: 0 },
    rows: [],
    roleOptions: [
      { value: 'Guard', label: 'Guard', baseRole: 'guard' },
      { value: 'Dispatcher', label: 'Dispatcher', baseRole: 'dispatcher' },
      { value: 'Scheduler', label: 'Scheduler', baseRole: 'scheduler' },
      { value: 'Supervisor', label: 'Supervisor', baseRole: 'supervisor' },
      { value: 'Recruiting Licensing', label: 'Recruiting Licensing', baseRole: 'recruiting_licensing' },
      { value: 'Admin', label: 'Admin', baseRole: 'admin' },
      { value: 'Chief', label: 'Chief', baseRole: null },
      { value: 'Human Resources Employee', label: 'Human Resources Employee', baseRole: null },
      { value: 'Human Resources Manager', label: 'Human Resources Manager', baseRole: null },
      { value: 'Operations Manager', label: 'Operations Manager', baseRole: null },
      { value: 'Audit & QA', label: 'Audit & QA', baseRole: null },
    ],
    ...overrides,
  }
}
