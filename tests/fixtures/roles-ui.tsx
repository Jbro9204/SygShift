import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EmployeeForm } from '../../src/pages/UserAdminPage'
import { employeeRoleFixtures, employeeRoleTestUser } from '../../src/test/employeeRoleFixtures'
import type { EmployeeMutationInput } from '../../src/data/adminUsers'
import '../../src/index.css'
import '../../src/App.css'
import '../../src/theme.css'

const theme = new URLSearchParams(location.search).get('theme') ?? 'light'
document.documentElement.dataset.theme = theme
document.documentElement.style.colorScheme = theme

function Fixture() {
  const [result, setResult] = useState('No changes saved')
  return <main style={{ margin: '24px auto', maxWidth: 1040, padding: '0 16px' }}>
    <h1>Manage employee</h1>
    <EmployeeForm accessRoles={employeeRoleFixtures} accessRolesReady assignedAccessRoleIds={['hr-manager-role']}
      canEditAdminRole canEditBasic canSeparate employee={employeeRoleTestUser} onCancel={() => undefined}
      onSubmit={(payload: EmployeeMutationInput) => setResult(JSON.stringify(payload))} pending={false} />
    <output aria-label="Saved role result" style={{ overflowWrap: 'anywhere' }}>{result}</output>
  </main>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
