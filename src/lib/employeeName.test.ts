import { describe, expect, it } from 'vitest'
import { employeeScheduleDisplayName, employeeScheduleGivenName } from './employeeName'

describe('employee schedule names', () => {
  it('uses a normal preferred name without adding unnecessary legal-name detail', () => {
    expect(employeeScheduleDisplayName({
      firstName: 'Zachary',
      lastName: 'Ward',
      preferredName: 'Zach',
    })).toBe('Zach Ward')
  })

  it('expands a one-character preferred name so schedule staff can identify the employee', () => {
    expect(employeeScheduleDisplayName({
      firstName: 'Jainique',
      lastName: 'Lee',
      preferredName: 'J',
    })).toBe('Jainique (J) Lee')
    expect(employeeScheduleGivenName({
      firstName: 'Jainique',
      lastName: 'Lee',
      preferredName: ' J ',
    })).toBe('Jainique (J)')
  })

  it('uses the legal first name when no preferred name is recorded', () => {
    expect(employeeScheduleDisplayName({
      firstName: 'Joseph',
      lastName: 'Lee',
      preferredName: null,
    })).toBe('Joseph Lee')
  })
})
