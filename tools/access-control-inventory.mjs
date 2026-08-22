import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const outputArgumentIndex = process.argv.indexOf('--output')
const outputPath = resolve(
  root,
  outputArgumentIndex >= 0 && process.argv[outputArgumentIndex + 1]
    ? process.argv[outputArgumentIndex + 1]
    : 'outputs/access-control/access-control-inventory.json',
)
const verifyOnly = process.argv.includes('--verify')

const ROLE_NAMES = ['admin', 'dispatcher', 'guard', 'recruiting_licensing', 'scheduler', 'supervisor']
const PERMISSION_PREFIXES = new Set([
  'accountability',
  'actions',
  'admin',
  'announcements',
  'availability',
  'directory',
  'events',
  'licensing',
  'notifications',
  'operations',
  'patrol',
  'reports',
  'requests',
  'schedule',
  'scheduler',
  'shift_pool',
  'sites',
  'time',
  'training',
])

function walk(directory, acceptedExtensions) {
  const results = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    const details = statSync(path)
    if (details.isDirectory()) {
      results.push(...walk(path, acceptedExtensions))
    } else if (acceptedExtensions.has(extname(entry))) {
      results.push(path)
    }
  }
  return results.sort()
}

function repoPath(path) {
  return relative(root, path).replaceAll('\\', '/')
}

function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length
}

function uniqueBy(items, keyFor) {
  return [...new Map(items.map((item) => [keyFor(item), item])).values()]
}

function permissionLiteral(value) {
  const [prefix] = value.split('.')
  return value.includes('.') && PERMISSION_PREFIXES.has(prefix) && /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/.test(value)
}

const allSourceFiles = [
  ...walk(join(root, 'src'), new Set(['.ts', '.tsx'])),
  ...walk(join(root, 'worker'), new Set(['.ts'])),
]
const sourceFiles = allSourceFiles.filter((path) => !/\.(?:test|spec)\.[^.]+$/i.test(path))
const migrationFiles = walk(join(root, 'supabase', 'migrations'), new Set(['.sql']))

const permissions = new Map()
const rpcCalls = []
const tableCalls = []
const fetchCalls = []
const roleChecks = []
const controls = []

for (const path of sourceFiles) {
  const source = readFileSync(path, 'utf8')
  const file = repoPath(path)

  for (const match of source.matchAll(/(['"])([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)\1/g)) {
    if (!permissionLiteral(match[2])) continue
    const occurrence = { file, line: lineNumber(source, match.index), source: 'typescript' }
    const existing = permissions.get(match[2]) ?? []
    existing.push(occurrence)
    permissions.set(match[2], existing)
  }

  for (const match of source.matchAll(/\.rpc\(\s*(['"])([a-zA-Z0-9_]+)\1/g)) {
    rpcCalls.push({ file, line: lineNumber(source, match.index), name: match[2], transport: 'supabase_client' })
  }
  for (const match of source.matchAll(/callRpc(?:<[^>]+>)?\([\s\S]{0,220}?(['"])([a-zA-Z0-9_]+)\1/g)) {
    rpcCalls.push({ file, line: lineNumber(source, match.index), name: match[2], transport: 'worker_service_role' })
  }
  for (const match of source.matchAll(/\.from\(\s*(['"])([a-zA-Z0-9_-]+)\1/g)) {
    tableCalls.push({ file, line: lineNumber(source, match.index), name: match[2] })
  }
  for (const match of source.matchAll(/fetch\(\s*([`'"])(\/api\/[^`'"]+)\1/g)) {
    fetchCalls.push({ file, line: lineNumber(source, match.index), path: match[2] })
  }

  const lines = source.split('\n')
  lines.forEach((line, index) => {
    const hasRoleName = ROLE_NAMES.some((role) => line.includes(`'${role}'`) || line.includes(`"${role}"`))
    const roleExpression = /\brole\b|\.role\b|current_app_role|OPERATIONS_ROLES|LICENSING_ROLES|ALL_EMPLOYEE_ROLES/.test(line)
    const decisionExpression = /===|!==|\.includes\(|\bsome\(|\bhas\(|\bin\s*\(/.test(line)
    if (hasRoleName && roleExpression && decisionExpression) {
      roleChecks.push({ file, line: index + 1, text: line.trim() })
    }
  })

  for (const match of source.matchAll(/<(button|TimeButton|Link|NavLink|ModalDialog)\b/g)) {
    controls.push({ file, kind: match[1], line: lineNumber(source, match.index) })
  }
}

for (const path of migrationFiles) {
  const source = readFileSync(path, 'utf8')
  const file = repoPath(path)
  for (const match of source.matchAll(/(['"])([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)\1/g)) {
    if (!permissionLiteral(match[2])) continue
    const occurrence = { file, line: lineNumber(source, match.index), source: 'migration' }
    const existing = permissions.get(match[2]) ?? []
    existing.push(occurrence)
    permissions.set(match[2], existing)
  }
}

const routerSource = readFileSync(join(root, 'src', 'app', 'router.tsx'), 'utf8')
const routes = []
for (const match of routerSource.matchAll(/(?:\bpath=|\bpath:)\s*['"]([^'"]+)['"]/g)) {
  routes.push({ line: lineNumber(routerSource, match.index), path: match[1].startsWith('/') ? match[1] : `/${match[1]}` })
}
if (!routes.some((route) => route.path === '/')) routes.unshift({ line: 39, path: '/' })

const navigationSource = readFileSync(join(root, 'src', 'app', 'navigation.ts'), 'utf8')
const navigation = []
for (const match of navigationSource.matchAll(/path:\s*'([^']+)'/g)) {
  const objectStart = navigationSource.lastIndexOf('{', match.index)
  const objectEnd = navigationSource.indexOf('}', match.index)
  const block = navigationSource.slice(objectStart, objectEnd + 1)
  const label = block.match(/label:\s*'([^']+)'/)?.[1]
  if (!label) continue
  const permissionMatches = [...block.matchAll(/'([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)'/g)]
    .map((item) => item[1])
    .filter(permissionLiteral)
  const roles = ROLE_NAMES.filter((role) => block.includes(`'${role}'`))
  const roleGroup = block.match(/roles:\s*([A-Z_]+)/)?.[1] ?? null
  navigation.push({
    label,
    line: lineNumber(navigationSource, objectStart),
    path: match[1],
    permissions: [...new Set(permissionMatches)],
    roleFallback: roles.length > 0 || Boolean(roleGroup),
    roles,
    roleGroup,
  })
}

const workerSource = readFileSync(join(root, 'worker', 'index.ts'), 'utf8')
const workerEndpoints = []
for (const match of workerSource.matchAll(/url\.pathname\s*(?:===|\.startsWith\()\s*['"]([^'"]+)['"]/g)) {
  workerEndpoints.push({ line: lineNumber(workerSource, match.index), path: match[1] })
}
for (const match of workerSource.matchAll(/\^\\\/api\\\/[^$]+\$/g)) {
  workerEndpoints.push({ line: lineNumber(workerSource, match.index), path: match[0] })
}

const currentFunctions = new Map()
const currentPolicies = new Map()
const unresolvedDynamicFunctionReplacements = []
for (const path of migrationFiles) {
  const source = readFileSync(path, 'utf8')
  const file = repoPath(path)
  const functionEvents = [
    ...[...source.matchAll(/create(?:\s+or\s+replace)?\s+function\s+([a-zA-Z0-9_."]+)\s*\(/gi)]
      .map((match) => ({ index: match.index, match, type: 'create' })),
    ...[...source.matchAll(/drop\s+function\s+(?:if\s+exists\s+)?([a-zA-Z0-9_."]+)\s*\(/gi)]
      .map((match) => ({ index: match.index, match, type: 'drop' })),
    ...[...source.matchAll(/alter\s+function\s+([a-zA-Z0-9_."]+)\s*\([^;]*?\)\s+rename\s+to\s+([a-zA-Z0-9_"]+)/gi)]
      .map((match) => ({ index: match.index, match, type: 'rename' })),
    ...[...source.matchAll(/alter\s+function\s+([a-zA-Z0-9_."]+)\s*\([^;]*?\)\s+set\s+schema\s+([a-zA-Z0-9_"]+)/gi)]
      .map((match) => ({ index: match.index, match, type: 'schema' })),
  ].sort((left, right) => left.index - right.index)
  functionEvents.forEach((event, index) => {
    const name = event.match[1].replaceAll('"', '').toLowerCase()
    if (event.type === 'drop') {
      currentFunctions.delete(name)
      return
    }
    if (event.type === 'rename') {
      const renamed = event.match[2].replaceAll('"', '').toLowerCase()
      const schema = name.includes('.') ? name.slice(0, name.lastIndexOf('.') + 1) : ''
      const renamedQualifiedName = `${schema}${renamed}`
      const current = currentFunctions.get(name)
      currentFunctions.delete(name)
      if (current) currentFunctions.set(renamedQualifiedName, { ...current, name: renamedQualifiedName })
      return
    }
    if (event.type === 'schema') {
      const unqualifiedName = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
      const targetSchema = event.match[2].replaceAll('"', '').toLowerCase()
      const targetName = `${targetSchema}.${unqualifiedName}`
      const current = currentFunctions.get(name)
      currentFunctions.delete(name)
      if (current) currentFunctions.set(targetName, { ...current, name: targetName })
      return
    }
    const nextEvent = functionEvents[index + 1]?.index ?? source.length
    const provisionalBlock = source.slice(event.index, nextEvent)
    const delimiterMatch = provisionalBlock.match(/\bas\s+(\$[a-zA-Z0-9_]*\$)/i)
    let block = provisionalBlock
    if (delimiterMatch?.index !== undefined) {
      const bodyStart = delimiterMatch.index + delimiterMatch[0].length
      const bodyEnd = provisionalBlock.indexOf(delimiterMatch[1], bodyStart)
      if (bodyEnd >= 0) block = provisionalBlock.slice(0, bodyEnd + delimiterMatch[1].length)
    }
    currentFunctions.set(name, {
      definition: block,
      file,
      line: lineNumber(source, event.index),
      name,
      securityDefiner: /security\s+definer/i.test(block),
      effectivePermission: /has_effective_permission|require_effective_permission|require_any_effective_permission/i.test(block),
      legacyRoleCheck: /current_app_role|is_admin\s*\(|is_supervisor_or_admin\s*\(|require_admin_mfa|require_supervisor_mfa|role\s+in\s*\(/i.test(block),
      mfaCheck: /aal2|mfa|required_mfa|require_admin_mfa|require_supervisor_mfa|require_effective_permission/i.test(block),
      permissions: [...new Set([...block.matchAll(/['"]([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)['"]/g)]
        .map((item) => item[1])
        .filter(permissionLiteral))],
    })
  })

  for (const match of source.matchAll(/select\s+pg_temp\.replace_function_authorization\(\s*'((?:''|[^'])*)'\s*,\s*'((?:''|[^'])*)'\s*,\s*'((?:''|[^'])*)'\s*\);/gi)) {
    const signature = match[1].replaceAll("''", "'")
    const expected = match[2].replaceAll("''", "'")
    const replacement = match[3].replaceAll("''", "'")
    const name = signature.slice(0, signature.indexOf('(')).toLowerCase()
    const current = currentFunctions.get(name)
    if (!current) continue
    if (!current.definition.includes(expected)) {
      // Some historical migrations rewrite a function body through pg_get_functiondef()
      // before this migration performs its final authorization replacement. The static
      // inventory cannot execute that dynamic SQL, so retain the last statically known
      // definition and report the unresolved replacement for live-catalog verification.
      unresolvedDynamicFunctionReplacements.push({ file, name, signature })
      continue
    }
    const block = current.definition.replace(expected, replacement)
    currentFunctions.set(name, {
      ...current,
      definition: block,
      effectivePermission: /has_effective_permission|has_any_effective_permission|require_effective_permission|require_any_effective_permission/i.test(block),
      legacyRoleCheck: /current_app_role|is_admin\s*\(|is_supervisor_or_admin\s*\(|require_admin_mfa|require_supervisor_mfa|role\s+in\s*\(/i.test(block),
      mfaCheck: /aal2|mfa|required_mfa|require_admin_mfa|require_supervisor_mfa|require_effective_permission|has_effective_permission|has_any_effective_permission/i.test(block),
      permissions: [...new Set([...block.matchAll(/['"]([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)['"]/g)]
        .map((item) => item[1])
        .filter(permissionLiteral))],
    })
  }

  const policyEvents = [
    ...[...source.matchAll(/drop\s+policy\s+if\s+exists\s+(?:"([^"]+)"|([a-zA-Z0-9_]+))\s+on\s+([a-zA-Z0-9_."]+)/gi)]
      .map((match) => ({ index: match.index, match, type: 'drop' })),
    ...[...source.matchAll(/create\s+policy\s+(?:"([^"]+)"|([a-zA-Z0-9_]+))\s+on\s+([a-zA-Z0-9_."]+)[\s\S]*?;/gi)]
      .map((match) => ({ index: match.index, match, type: 'create' })),
  ].sort((left, right) => left.index - right.index)
  for (const event of policyEvents) {
    const name = event.match[1] ?? event.match[2]
    const table = event.match[3].replaceAll('"', '').toLowerCase()
    const key = `${table}:${name.toLowerCase()}`
    if (event.type === 'drop') {
      currentPolicies.delete(key)
      continue
    }
    const block = event.match[0]
    currentPolicies.set(`${table}:${name.toLowerCase()}`, {
      file,
      line: lineNumber(source, event.index),
      name,
      table,
      effectivePermission: /has_effective_permission/i.test(block),
      legacyRoleCheck: /current_app_role|is_admin\s*\(|is_supervisor_or_admin\s*\(|role\s+in\s*\(/i.test(block),
    })
  }
}

const latestFunctions = [...currentFunctions.values()].sort((a, b) => a.name.localeCompare(b.name))
const policies = [...currentPolicies.values()].sort((a, b) => `${a.table}:${a.name}`.localeCompare(`${b.table}:${b.name}`))
const inventory = {
  generatedAt: new Date().toISOString(),
  gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  source: {
    migrationFiles: migrationFiles.length,
    testFilesExcluded: allSourceFiles.length - sourceFiles.length,
    sourceFiles: sourceFiles.length,
  },
  frontend: {
    controls: {
      byKind: Object.fromEntries([...new Set(controls.map((control) => control.kind))].sort().map((kind) => [kind, controls.filter((control) => control.kind === kind).length])),
      total: controls.length,
    },
    fetchCalls: uniqueBy(fetchCalls, (item) => `${item.file}:${item.line}:${item.path}`),
    navigation,
    roleChecks: uniqueBy(roleChecks, (item) => `${item.file}:${item.line}:${item.text}`),
    routes: uniqueBy(routes, (item) => item.path),
    rpcCalls: uniqueBy(rpcCalls, (item) => `${item.transport}:${item.name}:${item.file}:${item.line}`),
    tableCalls: uniqueBy(tableCalls, (item) => `${item.name}:${item.file}:${item.line}`),
  },
  backend: {
    currentFunctions: latestFunctions,
    currentPolicies: policies,
    unresolvedDynamicFunctionReplacements,
    workerEndpoints: uniqueBy(workerEndpoints, (item) => `${item.path}:${item.line}`),
  },
  permissions: [...permissions.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, occurrences]) => ({ name, occurrences })),
  summary: {
    currentFunctions: latestFunctions.length,
    currentFunctionsWithEffectivePermission: latestFunctions.filter((item) => item.effectivePermission).length,
    currentFunctionsWithLegacyRoleChecks: latestFunctions.filter((item) => item.legacyRoleCheck).length,
    currentPolicies: policies.length,
    currentPoliciesWithEffectivePermission: policies.filter((item) => item.effectivePermission).length,
    currentPoliciesWithLegacyRoleChecks: policies.filter((item) => item.legacyRoleCheck).length,
    unresolvedDynamicFunctionReplacements: unresolvedDynamicFunctionReplacements.length,
    navigationItems: navigation.length,
    navigationItemsWithRoleFallback: navigation.filter((item) => item.roleFallback).length,
    permissions: permissions.size,
    roleChecksInApplicationSource: roleChecks.length,
    routes: routes.length,
    rpcNamesCalled: new Set(rpcCalls.map((item) => item.name)).size,
    workerEndpoints: new Set(workerEndpoints.map((item) => item.path)).size,
  },
}

const requiredChecks = [
  [inventory.frontend.routes.some((route) => route.path === '/access-control'), 'Roles & Permissions route was not inventoried.'],
  [inventory.frontend.navigation.some((item) => item.path === '/users'), 'Users & Access navigation was not inventoried.'],
  [inventory.frontend.rpcCalls.some((call) => call.name === 'get_session_context'), 'Session context RPC was not inventoried.'],
  [inventory.backend.currentFunctions.some((item) => item.name.endsWith('.has_effective_permission')), 'Effective-permission function was not inventoried.'],
  [inventory.permissions.some((permission) => permission.name === 'admin.roles.manage'), 'Core role-management permission was not inventoried.'],
  [inventory.summary.currentPolicies > 0, 'No current RLS policies were inventoried.'],
]
const failures = requiredChecks.filter(([passed]) => !passed).map(([, message]) => message)
if (failures.length > 0) {
  throw new Error(`Access-control inventory verification failed:\n- ${failures.join('\n- ')}`)
}

if (!verifyOnly) {
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(inventory, null, 2)}\n`)
  console.log(`Wrote ${repoPath(outputPath)}`)
}
console.log(JSON.stringify(inventory.summary, null, 2))
