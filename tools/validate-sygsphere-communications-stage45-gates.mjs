import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const readWorkspaceFile = (relativePath) => readFileSync(resolve(process.cwd(), relativePath), 'utf8')

const failures = []
const gateContract = readWorkspaceFile('shared/sygsphere-communications/v1/integration-gates.ts')
const workerConfiguration = readWorkspaceFile('wrangler.jsonc')
const workerEntrypoint = readWorkspaceFile('worker/index.ts')
const cloudflareAdapter = readWorkspaceFile('worker/comms/cloudflareRealtimeAdapter.ts')

if (!gateContract.includes('closedCommunicationsRuntimeGate')) {
  failures.push('The closed-by-default communications runtime gate is missing.')
}

if (!gateContract.includes('providerPhysicalDeviceEvidenceComplete: false')) {
  failures.push('The physical-device evidence gate is not explicitly closed.')
}

if (!gateContract.includes('coordinatorDeploymentApproved: false')) {
  failures.push('The coordinator deployment gate is not explicitly closed.')
}

if (!/"TENANT_COMMS"\s*,\s*\n\s*"class_name"\s*:\s*"TenantCommsDurableObject"/.test(workerConfiguration)) {
  failures.push('The closed coordinator Durable Object binding is missing.')
}

if (!/"SYGSHIFT_SYGSPHERE_COMMS_RUNTIME_ENABLED"\s*:\s*"true"/.test(workerConfiguration)) {
  failures.push('The coordinator runtime flag is not explicitly enabled.')
}

if (!cloudflareAdapter.includes('SYGSPHERE_COMMS_CLOUDFLARE_REALTIME_ADAPTER_RELEASED = true as const')) {
  failures.push('The reviewed Cloudflare Realtime adapter release boundary remains closed.')
}

for (const binding of ['SYGSHIFT_COMMS_REALTIME_APP_SECRET', 'SYGSHIFT_COMMS_TURN_API_TOKEN']) {
  if (!workerConfiguration.includes(binding)) failures.push(`The server-only ${binding} binding is missing.`)
}

if (!workerEntrypoint.includes("url.pathname.startsWith('/api/comms/v1/')")) {
  failures.push('The protected Communications service ingress is missing.')
}

if (!workerEntrypoint.includes('if (!sygsphereCommunicationsRuntimeEnabled(environment))')) {
  failures.push('The Communications service ingress can bypass the explicit runtime gate.')
}

if (failures.length > 0) {
  console.error('SygSphere Communications Stage 4/5 release gate failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log('SygSphere Communications Stage 4/5 protected ingress and live provider release controls are prepared.')
}
