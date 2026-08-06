/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const appShell = readFileSync(join(process.cwd(), 'src', 'components', 'AppShell.tsx'), 'utf8')

describe('workspace session continuity guardrails', () => {
  it('warns at 25 minutes and signs out at 30 minutes of inactivity', () => {
    expect(appShell).toContain('const INACTIVITY_WARNING_MS = 25 * 60 * 1000')
    expect(appShell).toContain('const INACTIVITY_LOGOUT_MS = 30 * 60 * 1000')
  })

  it('refreshes background-tab authentication without unmounting the active workspace', () => {
    expect(appShell).toContain('auth.onAuthStateChange((_event, session) =>')
    expect(appShell).toContain('void loadSessionContext(false)')
    expect(appShell).not.toContain('\n      void loadSessionContext()\n    })')
  })
})
