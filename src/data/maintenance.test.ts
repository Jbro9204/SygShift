import { describe, expect, it } from 'vitest'
import {
  MAINTENANCE_FEATURES,
  maintenanceFeatureForPath,
  maintenanceFeatureLabel,
} from './maintenance'

describe('maintenance feature boundaries', () => {
  it('maps protected routes to their database feature boundary', () => {
    expect(maintenanceFeatureForPath('/scheduler')).toBe('schedule')
    expect(maintenanceFeatureForPath('/schedule/week/2026-08-23')).toBe('schedule')
    expect(maintenanceFeatureForPath('/time/payroll')).toBe('payroll')
    expect(maintenanceFeatureForPath('/payroll')).toBe('payroll')
    expect(maintenanceFeatureForPath('/payroll/review')).toBe('payroll')
    expect(maintenanceFeatureForPath('/time/operations')).toBe('time_attendance')
    expect(maintenanceFeatureForPath('/users')).toBe('user_accounts')
    expect(maintenanceFeatureForPath('/system-operations')).toBeNull()
  })

  it('keeps feature codes unique and provides an employee-facing label for each one', () => {
    const codes = MAINTENANCE_FEATURES.map((feature) => feature.code)
    expect(new Set(codes).size).toBe(codes.length)
    for (const code of codes) expect(maintenanceFeatureLabel(code)).not.toBe(code)
  })
})
