/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync('src/App.tsx', 'utf8')
const baseStyles = readFileSync('src/index.css', 'utf8')
const formStyles = readFileSync('src/styles/form-controls.css', 'utf8')

describe('global text-entry typography', () => {
  it('keeps textarea inheritance in the base control reset', () => {
    expect(baseStyles).toMatch(/body,\s*button,\s*input,\s*select,\s*textarea\s*{\s*font:\s*inherit;/s)
  })

  it('loads the final control override and uses readable product typography', () => {
    expect(app).toContain("import './styles/form-controls.css'")
    expect(app.indexOf("import './styles/form-controls.css'")).toBeGreaterThan(app.indexOf("import './styles/platform-launchers.css'"))
    expect(formStyles).toContain('input:not(')
    expect(formStyles).toContain('textarea')
    expect(formStyles).toContain('font-family: Aptos, "Segoe UI", system-ui')
    expect(formStyles).toContain('font-size: 1rem !important')
    expect(formStyles).not.toMatch(/monospace|consolas|courier/i)
  })
})
