import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const policy = readFileSync(resolve(root, 'shared/sygsphere-communications/v1/presentation-policy.ts'), 'utf8')
const activeRuntime = [
  resolve(root, 'src'),
  resolve(root, 'worker'),
]

const forbiddenRuntimePatterns = [
  /getUserMedia/,
  /getDisplayMedia/,
  /RTCPeerConnection/,
  /new\s+WebSocket\s*\(/,
]

const readRuntimeFiles = (directory) => {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = resolve(directory, entry.name)
    if (entry.isDirectory()) return readRuntimeFiles(file)
    return entry.isFile() && /\.(?:ts|tsx)$/.test(file) && !/\.test\.(?:ts|tsx)$/.test(file) ? [file] : []
  })
}

const runtimeFiles = activeRuntime.flatMap(readRuntimeFiles)
const violations = runtimeFiles.flatMap((file) => {
  const contents = readFileSync(file, 'utf8')
  return forbiddenRuntimePatterns
    .filter((pattern) => pattern.test(contents))
    .map((pattern) => `${file}: ${pattern}`)
})

if (!policy.includes("SYGSPHERE_COMMS_PRESENTATION_PROFILE_VERSION = '1.0.0-draft.1'")) {
  throw new Error('The shared Stage 6/7 presentation profile version is missing.')
}

if (!policy.includes("'Hold to talk'") || !policy.includes("'Release to stop'")) {
  throw new Error('The Stage 7 hold-to-talk guidance is incomplete.')
}

if (violations.length > 0) {
  throw new Error(`Stage 6/7 preparation cannot add live browser media controls: ${violations.join('; ')}`)
}

console.log(JSON.stringify({
  stage: '6-7-preparation',
  status: 'closed-by-default',
  checkedRuntimeFiles: runtimeFiles.length,
  browserMediaControls: 'absent',
}, null, 2))
