/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const appShell = readFileSync(join(process.cwd(), 'src', 'components', 'AppShell.tsx'), 'utf8')

describe('workspace session continuity guardrails', () => {
  it('warns at 55 minutes and signs out at 60 minutes of inactivity', () => {
    expect(appShell).toContain('const INACTIVITY_WARNING_MS = 55 * 60 * 1000')
    expect(appShell).toContain('const INACTIVITY_LOGOUT_MS = 60 * 60 * 1000')
    expect(appShell).toContain("const SESSION_ACTIVITY_STORAGE_PREFIX = 'sygshift.session.activity.v1'")
    expect(appShell).toContain("window.addEventListener('storage', handleSharedActivity)")
    expect(appShell).toContain('const sharedActivityKey = `${SESSION_ACTIVITY_STORAGE_PREFIX}:${sessionContext.employeeId}`')
  })

  it('refreshes background-tab authentication without unmounting the active workspace', () => {
    expect(appShell).toContain('auth.onAuthStateChange((_event, session) =>')
    expect(appShell).toContain('void loadSessionContext(false)')
    expect(appShell).not.toContain('\n      void loadSessionContext()\n    })')
  })
})
