import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const workspaceFile = (relativePath: string): string =>
  readFileSync(resolve(import.meta.dirname, '..', relativePath), 'utf8')

describe('SygSphere Communications Stage 5/6 release guard', () => {
  it('keeps the pure lifecycle free of device side effects while AppShell mounts the reviewed host', () => {
    const appShell = workspaceFile('src/components/AppShell.tsx')
    const lifecycle = workspaceFile('src/communications/sygsphereCommunicationsRuntimeLifecycle.ts')
    const viewModel = workspaceFile('src/communications/sygsphereCommunicationsSurfaceViewModel.ts')
    const combined = `${lifecycle}\n${viewModel}`

    expect(appShell).toContain('SygSphereCommunicationsRuntimeProvider')
    expect(combined).not.toMatch(/getUserMedia|mediaDevices|RTCPeerConnection|new\s+WebSocket\s*\(|EventSource/)
    expect(combined).not.toMatch(/localStorage|sessionStorage|fetch\s*\(/)
  })

  it('records the reviewed immutable client release switch', () => {
    const lifecycle = workspaceFile('src/communications/sygsphereCommunicationsRuntimeLifecycle.ts')
    expect(lifecycle).toContain('SYGSPHERE_COMMS_CLIENT_RUNTIME_RELEASED = true as const')
    expect(lifecycle).toContain('closedCommunicationsRuntimeGate')
  })
})
