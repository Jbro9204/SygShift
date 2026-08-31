import { describe, expect, it } from 'vitest'
import { summarizeUserAccounts, userAccountMetricRecord } from './userAccountMetrics'

describe('user account summary metrics', () => {
  it('counts only active primary-role administrators as current admins', () => {
    const metrics = summarizeUserAccounts([
      userAccountMetricRecord('active', 'admin', 'active'),
      userAccountMetricRecord('active', 'admin', 'active'),
      userAccountMetricRecord('separated', 'admin', 'disabled'),
      userAccountMetricRecord('inactive', 'admin', 'disabled'),
      userAccountMetricRecord('active', 'guard', 'not_created'),
    ])

    expect(metrics).toEqual({
      active: 3,
      activeAdmins: 2,
      missingLogins: 1,
      total: 5,
    })
  })

  it('does not count onboarding or leave records as active access', () => {
    const metrics = summarizeUserAccounts([
      userAccountMetricRecord('onboarding', 'admin', 'active'),
      userAccountMetricRecord('leave', 'admin', 'active'),
      userAccountMetricRecord('active', 'supervisor', 'active'),
    ])

    expect(metrics.active).toBe(1)
    expect(metrics.activeAdmins).toBe(0)
  })
})
