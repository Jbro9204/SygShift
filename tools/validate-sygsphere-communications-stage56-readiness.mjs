import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const readWorkspaceFile = (relativePath) => readFileSync(resolve(root, relativePath), 'utf8')
const lifecycle = readWorkspaceFile('src/communications/sygsphereCommunicationsRuntimeLifecycle.ts')
const viewModel = readWorkspaceFile('src/communications/sygsphereCommunicationsSurfaceViewModel.ts')
const appShell = readWorkspaceFile('src/components/AppShell.tsx')
const stage5Acceptance = readWorkspaceFile('docs/operations/SYGSPHERE_COMMUNICATIONS_STAGE_5_SHELL_ACCEPTANCE.md')
const stage67Acceptance = readWorkspaceFile('docs/operations/SYGSPHERE_COMMUNICATIONS_STAGE_6_7_ACCEPTANCE.md')

const failures = []
const closedRuntimePatterns = [
  /SYGSPHERE_COMMS_CLIENT_RUNTIME_RELEASED\s*=\s*false\s+as\s+const/,
  /closedCommunicationsRuntimeGate/,
  /requestsDevicePermission:\s*false/,
  /isInteractive:\s*false/,
]
const liveBrowserPatterns = [
  /getUserMedia/,
  /mediaDevices/,
  /RTCPeerConnection/,
  /new\s+WebSocket\s*\(/,
  /EventSource/,
  /localStorage/,
  /sessionStorage/,
  /fetch\s*\(/,
]

for (const pattern of closedRuntimePatterns) {
  if (!pattern.test(`${lifecycle}\n${viewModel}`)) {
    failures.push(`Readiness source is missing required closed-runtime control: ${pattern}`)
  }
}

for (const pattern of liveBrowserPatterns) {
  if (pattern.test(`${lifecycle}\n${viewModel}`)) {
    failures.push(`Readiness source cannot use live browser capability: ${pattern}`)
  }
}

if (/sygsphereCommunicationsRuntimeLifecycle|sygsphereCommunicationsSurfaceViewModel/.test(appShell)) {
  failures.push('AppShell cannot mount the Stage 5/6 communications readiness source.')
}

if (!/source-only lifecycle/i.test(stage5Acceptance) || !/source-only view-model/i.test(stage67Acceptance)) {
  failures.push('Stage 5/6 acceptance documentation does not describe the closed source-only preparation.')
}

if (failures.length > 0) {
  console.error('SygSphere Communications Stage 5/6 readiness gate failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log('SygSphere Communications Stage 5/6 readiness source remains closed and unmounted as intended.')
}
