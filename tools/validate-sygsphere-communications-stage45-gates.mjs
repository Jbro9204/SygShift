import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const readWorkspaceFile = (relativePath) => readFileSync(resolve(process.cwd(), relativePath), 'utf8')

const failures = []
const gateContract = readWorkspaceFile('shared/sygsphere-communications/v1/integration-gates.ts')
const workerConfiguration = readWorkspaceFile('wrangler.jsonc')
const workerEntrypoint = readWorkspaceFile('worker/index.ts')

if (!gateContract.includes('closedCommunicationsRuntimeGate')) {
  failures.push('The closed-by-default communications runtime gate is missing.')
}

if (!gateContract.includes('providerPhysicalDeviceEvidenceComplete: false')) {
  failures.push('The physical-device evidence gate is not explicitly closed.')
}

if (!gateContract.includes('coordinatorDeploymentApproved: false')) {
  failures.push('The coordinator deployment gate is not explicitly closed.')
}

if (/"TENANT_COMMS"|'TENANT_COMMS'/.test(workerConfiguration)) {
  failures.push('A TENANT_COMMS Durable Object binding is configured before Stage 4 approval.')
}

if (/sygsphere-communications|\/api\/(?:v1\/communications|comms\/v1)/.test(workerEntrypoint)) {
  failures.push('A communications Worker route is present before Stage 4 approval.')
}

if (failures.length > 0) {
  console.error('SygSphere Communications Stage 4/5 release gate failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log('SygSphere Communications Stage 4/5 release gate is closed as intended.')
}
