import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [beforeArgument, afterArgument] = process.argv.slice(2).filter((argument) => argument !== '--')
if (!beforeArgument || !afterArgument) {
  throw new Error('Usage: node tools/verify-production-access-preservation.mjs <before.json> <after.json>')
}

const readSnapshot = (path) => JSON.parse(readFileSync(resolve(path), 'utf8'))
const before = readSnapshot(beforeArgument)
const after = readSnapshot(afterArgument)

const accessProjection = (snapshot) => ({
  activeEmployees: snapshot.activeEmployees,
  permissions: snapshot.permissions,
  roles: snapshot.roles,
})
const stableText = (value) => JSON.stringify(value)
const fingerprint = (value) => createHash('sha256').update(stableText(value)).digest('hex')
const beforeProjection = accessProjection(before)
const afterProjection = accessProjection(after)

if (stableText(beforeProjection) !== stableText(afterProjection)) {
  const beforeEmployees = new Map(before.activeEmployees.map((employee) => [employee.id, employee]))
  const afterEmployees = new Map(after.activeEmployees.map((employee) => [employee.id, employee]))
  const changedEmployees = [...new Set([...beforeEmployees.keys(), ...afterEmployees.keys()])]
    .filter((employeeId) => stableText(beforeEmployees.get(employeeId)) !== stableText(afterEmployees.get(employeeId)))
  const changedRoles = before.roles
    .map((role) => role.code)
    .filter((roleCode) => {
      const beforeRole = before.roles.find((role) => role.code === roleCode)
      const afterRole = after.roles.find((role) => role.code === roleCode)
      return stableText(beforeRole) !== stableText(afterRole)
    })

  throw new Error([
    'Production access changed during permission enforcement.',
    `Changed employee access records: ${changedEmployees.length}`,
    `Changed role definitions: ${changedRoles.join(', ') || 'none'}`,
  ].join('\n'))
}

console.log(JSON.stringify({
  activeEmployees: after.activeEmployees.length,
  extraRoleAssignments: after.activeEmployees.reduce((total, employee) => total + employee.assignedRoleCodes.length, 0),
  fingerprint: fingerprint(afterProjection),
  permissionOverrides: after.activeEmployees.reduce((total, employee) => total + employee.overrides.length, 0),
  permissions: after.permissions.length,
  preserved: true,
  roles: after.roles.length,
}, null, 2))
