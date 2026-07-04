import { describe, expect, it } from 'vitest'
import { credentialsToCsv, type AdminUserDirectory, type ProvisioningCredential } from './adminUsers'

describe('admin user helpers', () => {
  it('exports temporary credentials as safe CSV', () => {
    const credentials: ProvisioningCredential[] = [{
      action: 'created_auth_user',
      displayName: 'Jordan Brown',
      role: 'admin',
      temporaryPassword: 'StrongPass!234',
      username: 'jbrown',
    }]

    expect(credentialsToCsv(credentials)).toContain('Jordan Brown,jbrown,admin')
  })

  it('keeps user directory records explicit about login state', () => {
    const directory: AdminUserDirectory = {
      currentEmployeeId: '73000000-0000-4000-8000-000000000001',
      serverTimestamp: '2026-07-04T02:00:00.000Z',
      users: [{
        account: null,
        accountStatus: 'not_created',
        companyEmail: null,
        credentials: [],
        displayName: 'Jordan Brown',
        employeeNumber: null,
        employmentType: 'salary',
        firstName: 'Jordan',
        hiredOn: null,
        id: '73000000-0000-4000-8000-000000000001',
        lastName: 'Brown',
        middleName: null,
        mobilePhone: null,
        personalEmail: null,
        photoPath: null,
        preferredName: null,
        role: 'admin',
        separatedOn: null,
        status: 'active',
        username: 'jbrown',
      }],
    }

    expect(directory.users[0].accountStatus).toBe('not_created')
  })
})
