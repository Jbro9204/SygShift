import { readFileSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const root = process.cwd()
const readWorkspaceFile = (relativePath) => readFileSync(resolve(root, relativePath), 'utf8')
const policy = readWorkspaceFile('shared/sygsphere-communications/v1/presentation-policy.ts')
const panel = readWorkspaceFile('src/components/communications/SygSphereCommunicationsPanel.tsx')
const styles = readWorkspaceFile('src/styles/sygsphere-communications.css')
const headers = readWorkspaceFile('public/_headers')
const allowedCapabilityFiles = new Set([
  'src/communications/sygsphereCommunicationsBrowserCapabilities.ts',
  'src/communications/sygsphereCommunicationsMedia.ts',
  'src/communications/sygsphereCommunicationsPeerTransport.ts',
  'src/communications/sygsphereCommunicationsSocketBridge.ts',
  'src/components/communications/SygSphereCommunicationsRuntime.tsx',
  'src/data/sygsphereCommunications.ts',
])

const readRuntimeFiles = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const file = resolve(directory, entry.name)
  if (entry.isDirectory()) return readRuntimeFiles(file)
  return entry.isFile() && /\.(?:ts|tsx)$/.test(file) && !/\.test\.(?:ts|tsx)$/.test(file) ? [file] : []
})

const failures = []
const capabilityPattern = /getUserMedia|getDisplayMedia|RTCPeerConnection|new\s+WebSocket\s*\(/
for (const file of [resolve(root, 'src'), resolve(root, 'worker')].flatMap(readRuntimeFiles)) {
  const workspacePath = relative(root, file).replaceAll('\\', '/')
  if (capabilityPattern.test(readFileSync(file, 'utf8')) && !allowedCapabilityFiles.has(workspacePath)) {
    failures.push(`Browser media capability escaped its reviewed boundary: ${workspacePath}.`)
  }
}

if (!policy.includes("SYGSPHERE_COMMS_PRESENTATION_PROFILE_VERSION = '1.0.0-draft.1'")) {
  failures.push('The shared presentation profile version is missing.')
}
if (!policy.includes("'Hold to talk'") || !policy.includes("'Release to stop'")) {
  failures.push('The shared hold-to-talk guidance is incomplete.')
}
if (!panel.includes('Hold to talk') || !panel.includes('release to stop')) {
  failures.push('The live panel does not present clear press-and-release PTT guidance.')
}
if (!styles.includes('@media') || !styles.includes('sphere-comms-panel')) {
  failures.push('The communications controls do not include their responsive presentation layer.')
}
if (!headers.includes('camera=(self)') || !headers.includes('microphone=(self)')) {
  failures.push('The production browser policy does not allow same-origin camera and microphone use.')
}

if (failures.length > 0) {
  console.error('SygSphere Communications Stage 6/7 activation gate failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(JSON.stringify({
    stage: '6-7-activation',
    status: 'activation-candidate',
    browserMediaControls: 'mounted-in-reviewed-boundaries',
    physicalDeviceAcceptance: 'separate-required-gate',
  }, null, 2))
}
