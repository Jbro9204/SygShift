import { describe, expect, it } from 'vitest'
import {
  employeeDisplayName,
  employeeInitials,
  parseDirectoryEntries,
  type DirectoryEntry,
} from './workforce'

const employee: DirectoryEntry = {
  id: '10000000-0000-4000-8000-000000000001',
  employee_number: 'G-100',
  username: 'arivera',
  first_name: 'Alexandra',
  middle_name: null,
  last_name: 'Rivera',
  preferred_name: 'Alex',
  role: 'guard',
  employment_type: 'hourly',
  status: 'active',
  photo_path: null,
  hired_on: '2026-01-01',
  personal_email: null,
  company_email: 'alex@example.invalid',
  mobile_phone: null,
  credentials: [
    { kind: 'guard_license', status: 'active', expires_on: '2027-01-01' },
    { kind: 'first_aid_cpr', status: 'active', expires_on: null },
    { kind: 'site_training', status: 'pending', expires_on: null },
  ],
}

describe('workforce presentation', () => {
  it('accepts the exact credential kinds defined by PostgreSQL', () => {
    const parsed = parseDirectoryEntries([employee])
    expect(parsed[0].credentials.map((credential) => credential.kind)).toEqual([
      'guard_license',
      'first_aid_cpr',
      'site_training',
    ])
  })

  it('uses preferred names consistently', () => {
    expect(employeeDisplayName(employee)).toBe('Alex Rivera')
    expect(employeeInitials(employee)).toBe('AR')
  })
})
