import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const readWorkspaceFile = (relativePath) => readFileSync(resolve(root, relativePath), 'utf8')
const lifecycle = readWorkspaceFile('src/communications/sygsphereCommunicationsRuntimeLifecycle.ts')
const appShell = readWorkspaceFile('src/components/AppShell.tsx')
const runtime = readWorkspaceFile('src/components/communications/SygSphereCommunicationsRuntime.tsx')
const panel = readWorkspaceFile('src/components/communications/SygSphereCommunicationsPanel.tsx')
const media = readWorkspaceFile('src/communications/sygsphereCommunicationsMedia.ts')
const peerTransport = readWorkspaceFile('src/communications/sygsphereCommunicationsPeerTransport.ts')
const socketBridge = readWorkspaceFile('src/communications/sygsphereCommunicationsSocketBridge.ts')

const failures = []

if (!/SYGSPHERE_COMMS_CLIENT_RUNTIME_RELEASED\s*=\s*true\s+as\s+const/.test(lifecycle)) {
  failures.push('The reviewed client runtime release boundary is not enabled.')
}

for (const requirement of [
  'SygSphereCommunicationsRuntimeProvider',
  'sygsphere.comms.use',
  'requiredActionCheckpointActive',
]) {
  if (!appShell.includes(requirement)) failures.push(`AppShell is missing ${requirement}.`)
}

if (!runtime.includes('SygSphereCommunicationsWorkspace')
  || !runtime.includes('SygSphereCommunicationsPanel')
  || !runtime.includes('Incoming SygSphere call')) {
  failures.push('The global runtime does not mount the workspace, control panel, and incoming-call experience.')
}

if (!media.includes('getUserMedia') || !media.includes('getDisplayMedia')) {
  failures.push('The dedicated browser media controller does not support microphone, camera, and screen capture.')
}

if (!peerTransport.includes('RTCPeerConnection')) failures.push('The dedicated WebRTC peer transport is missing.')
if (!socketBridge.includes('new WebSocket')) failures.push('The protected control-channel bridge is missing.')

for (const [control, evidence] of [
  ['Hold to talk', 'Hold to talk'],
  ['conversation-scoped private Call', 'Private voice'],
  ['conversation-scoped Meet', 'Voice or video'],
  ['Camera', 'Camera'],
  ['Share screen', 'Share screen'],
]) {
  if (!panel.includes(evidence)) failures.push(`The communications panel is missing the ${control} control.`)
}

if (!panel.includes('conversationKind === "channel"') || !panel.includes('conversationKind === "direct"')) {
  failures.push('Voice controls are not scoped to the selected channel or direct conversation.')
}

if (failures.length > 0) {
  console.error('SygSphere Communications Stage 5/6 activation gate failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log('SygSphere Communications Stage 5/6 client runtime, media transports, and workspace controls are activated.')
}
