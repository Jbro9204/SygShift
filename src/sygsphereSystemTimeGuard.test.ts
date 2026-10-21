/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const sphere = readFileSync(join(root, 'src', 'pages', 'SygSpherePage.tsx'), 'utf8')
const clientCommunications = readFileSync(join(root, 'src', 'components', 'ClientCommunications.tsx'), 'utf8')

describe('SygSphere viewer system-time guardrails', () => {
  it('uses the shared viewer-local formatter for every visible SygSphere timestamp', () => {
    expect(sphere.match(/formatSygSphereTimestamp\(/g)).toHaveLength(3)
    expect(sphere).not.toContain("timeZone: 'America/Denver'")
    expect(sphere).not.toContain(' MT`')
  })

  it('keeps SygSphere-linked Client Communications timestamps in device system time', () => {
    expect(clientCommunications).toContain('browserSystemTimeZone()')
    expect(clientCommunications).toContain('timeZone: systemTimeZone')
  })
})
