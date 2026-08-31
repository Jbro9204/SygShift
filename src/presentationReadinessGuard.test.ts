/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const appCss = readFileSync(join(root, 'src', 'App.css'), 'utf8')
const modalDialog = readFileSync(join(root, 'src', 'components', 'ModalDialog.tsx'), 'utf8')
const peopleWorkspace = readFileSync(join(root, 'src', 'pages', 'HrisPeopleWorkspacePage.tsx'), 'utf8')

describe('presentation-readiness guardrails', () => {
  it('gives every modal unique accessible labels', () => {
    expect(modalDialog).toContain('const titleId = useId()')
    expect(modalDialog).toContain('const descriptionId = useId()')
    expect(modalDialog).toContain('aria-labelledby={titleId}')
    expect(modalDialog).not.toContain('id="modal-title"')
    expect(modalDialog).not.toContain('id="modal-description"')
  })

  it('keeps the final shared modal spacing rules last in the stylesheet', () => {
    const marker = '/* Final presentation-readiness overrides. Keep these last so shared spacing wins. */'
    const markerIndex = appCss.lastIndexOf(marker)

    expect(markerIndex).toBeGreaterThan(0)
    expect(appCss.slice(markerIndex)).toContain('padding: 22px var(--presentation-gutter)')
    expect(appCss.slice(markerIndex)).toContain('margin-right: var(--presentation-gutter)')
    expect(appCss.slice(markerIndex)).toContain('min-height: var(--presentation-control-height)')
    expect(appCss.slice(markerIndex)).toContain('width: calc(100vw - 16px)')
    expect(appCss.slice(markerIndex).trimEnd().endsWith('}')).toBe(true)
  })

  it('keeps HR workforce lists compact by default', () => {
    expect(peopleWorkspace).toContain('pageSize: isOverview ? 5 : 10')
    expect(peopleWorkspace).toContain('current.pageSize === 5 ? 10 : current.pageSize')
    expect(peopleWorkspace).not.toContain('pageSize: isOverview ? 5 : 15')
  })
})
