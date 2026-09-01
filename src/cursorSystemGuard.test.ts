/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const cursorCss = readFileSync(join(root, 'src', 'cursors.css'), 'utf8')
const appShell = readFileSync(join(root, 'src', 'components', 'AppShell.tsx'), 'utf8')
const app = readFileSync(join(root, 'src', 'App.tsx'), 'utf8')
const cursorNames = ['default', 'link', 'text', 'busy', 'move', 'blocked'] as const

describe('authenticated SygShift cursor system', () => {
  it('keeps all six local cursor assets compact and centrally imported', () => {
    expect(app).toContain("import './cursors.css'")
    for (const name of cursorNames) {
      const asset = readFileSync(join(root, 'public', 'cursors', `sygshift-${name}.svg`), 'utf8')
      expect(asset).toContain('width="24" height="26"')
      expect(asset).not.toContain('<script')
      expect(cursorCss).toContain(`url('/cursors/sygshift-${name}.svg')`)
    }
  })

  it('uses exact semantic native fallbacks and stable arrow hotspots', () => {
    expect(cursorCss).toContain("url('/cursors/sygshift-default.svg') 2 1, default")
    expect(cursorCss).toContain("url('/cursors/sygshift-link.svg') 10 2, pointer")
    expect(cursorCss).toContain("url('/cursors/sygshift-text.svg') 12 13, text")
    expect(cursorCss).toContain("url('/cursors/sygshift-busy.svg') 2 1, progress")
    expect(cursorCss).toContain("url('/cursors/sygshift-move.svg') 12 13, move")
    expect(cursorCss).toContain("url('/cursors/sygshift-blocked.svg') 2 1, not-allowed")
    expect(cursorCss).not.toMatch(/cursor:\s*none/)
  })

  it('forces the system only for authenticated fine pointers and preserves accessibility fallbacks', () => {
    expect(appShell).toContain("setAttribute('data-sygshift-cursors', 'active')")
    expect(appShell).toContain("removeAttribute('data-sygshift-cursors')")
    expect(cursorCss).toContain('@media (hover: hover) and (pointer: fine)')
    expect(cursorCss).toContain('(forced-colors: active)')
    expect(cursorCss).toContain('--sygshift-cursor-default: default')
    expect(cursorCss).toContain('--sygshift-cursor-blocked: not-allowed')
    expect(cursorCss).not.toContain('pointermove')
    expect(cursorCss).not.toContain('mousemove')
  })

  it('keeps disabled and busy states ahead of ordinary action, text, and move mappings', () => {
    expect(cursorCss).toContain(":disabled,")
    expect(cursorCss).toContain("[aria-disabled='true']")
    expect(cursorCss).toContain("[data-permission-denied='true']")
    expect(cursorCss).toContain("[aria-busy='true']")
    expect(cursorCss).toContain("[draggable='true']")
    expect(cursorCss).toContain('.account-photo-cropper__stage')
    expect(cursorCss.indexOf("[data-permission-denied='true']")).toBeGreaterThan(cursorCss.indexOf("[contenteditable='true']"))
  })
})
