import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [beforeArgument, afterArgument] = process.argv.slice(2).filter((argument) => argument !== '--')
if (!beforeArgument || !afterArgument) {
  throw new Error('Usage: node tools/verify-production-admin-permission-baseline.mjs <before.json> <after.json>')
}

const readSnapshot = (path) => JSON.parse(readFileSync(resolve(path), 'utf8'))
const before = readSnapshot(beforeArgument)
const after = readSnapshot(afterArgument)
const stable = (value) => JSON.stringify(value)
const hash = (value) => createHash('sha256').update(stable(value)).digest('hex')
const sorted = (values) => [...values].sort()

if (stable(before.permissions) !== stable(after.permissions)) {
  throw new Error('The permission catalog changed during Admin activation.')
}

const activePermissionCodes = sorted(after.permissions.filter((permission) => permission.active).map((permission) => permission.code))
const beforeRoles = new Map(before.roles.map((role) => [role.code, role]))
const afterRoles = new Map(after.roles.map((role) => [role.code, role]))

if (stable(sorted(beforeRoles.keys())) !== stable(sorted(afterRoles.keys()))) {
  throw new Error('The role catalog changed during Admin activation.')
}

for (const [roleCode, afterRole] of afterRoles) {
  const beforeRole = beforeRoles.get(roleCode)
  const beforeMetadata = { ...beforeRole, permissionCodes: undefined }
  const afterMetadata = { ...afterRole, permissionCodes: undefined }
  if (stable(beforeMetadata) !== stable(afterMetadata)) {
    throw new Error(`Role metadata changed for ${roleCode}.`)
  }
  if (roleCode === 'system_admin') {
    if (stable(sorted(afterRole.permissionCodes)) !== stable(activePermissionCodes)) {
      throw new Error('Admin does not have the complete active permission catalog.')
    }
  } else if (stable(beforeRole.permissionCodes) !== stable(afterRole.permissionCodes)) {
    throw new Error(`Permissions changed unexpectedly for ${roleCode}.`)
  }
}

const beforeEmployees = new Map(before.activeEmployees.map((employee) => [employee.id, employee]))
const afterEmployees = new Map(after.activeEmployees.map((employee) => [employee.id, employee]))
if (stable(sorted(beforeEmployees.keys())) !== stable(sorted(afterEmployees.keys()))) {
  throw new Error('The active employee population changed during Admin activation.')
}

let adminEmployeesUpdated = 0
for (const [employeeId, afterEmployee] of afterEmployees) {
  const beforeEmployee = beforeEmployees.get(employeeId)
  const beforeIdentity = { ...beforeEmployee, effectivePermissionCodes: undefined }
  const afterIdentity = { ...afterEmployee, effectivePermissionCodes: undefined }
  if (stable(beforeIdentity) !== stable(afterIdentity)) {
    throw new Error(`Employee role assignments or overrides changed for ${employeeId}.`)
  }

  if (afterEmployee.primaryRole === 'admin') {
    if (stable(sorted(afterEmployee.effectivePermissionCodes)) !== stable(activePermissionCodes)) {
      throw new Error(`Admin employee ${employeeId} does not have the complete active permission catalog.`)
    }
    if (stable(beforeEmployee.effectivePermissionCodes) !== stable(afterEmployee.effectivePermissionCodes)) {
      adminEmployeesUpdated += 1
    }
  } else if (stable(beforeEmployee.effectivePermissionCodes) !== stable(afterEmployee.effectivePermissionCodes)) {
    throw new Error(`Non-Admin effective access changed for ${employeeId}.`)
  }
}

const adminRole = afterRoles.get('system_admin')
const beforeAdminRole = beforeRoles.get('system_admin')
console.log(JSON.stringify({
  activeEmployees: after.activeEmployees.length,
  activePermissions: activePermissionCodes.length,
  adminEmployeesUpdated,
  adminPermissionsAdded: adminRole.permissionCodes.length - beforeAdminRole.permissionCodes.length,
  adminPermissionsAfter: adminRole.permissionCodes.length,
  fingerprint: hash({ activeEmployees: after.activeEmployees, permissions: after.permissions, roles: after.roles }),
  otherAccessPreserved: true,
}, null, 2))
