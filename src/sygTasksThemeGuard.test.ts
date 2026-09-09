import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(process.cwd(), 'src/styles/sygtasks.css'), 'utf8')
const pageSource = readFileSync(join(process.cwd(), 'src/pages/SygTasksPage.tsx'), 'utf8')

describe('SygTasks theme contract', () => {
  it('uses the canonical SygShift foreground tokens without light-only fallbacks', () => {
    expect(source).toContain('--tasks-ink: var(--ink, #1b1b19)')
    expect(source).toContain('--tasks-muted: var(--muted, #65625b)')
    expect(source).not.toContain('var(--text,')
    expect(source).not.toContain('var(--muted-text,')
  })

  it('shares its local theme tokens with workspace and dialog surfaces', () => {
    expect(source).toMatch(/\.sygtasks-workspace,\s*\.sygtasks-dialog,\s*\.sygtasks-detail-dialog,\s*\.sygtasks-loading,\s*\.sygtasks-unavailable\s*\{/)
    expect(source).toContain('color: var(--tasks-ink)')
    expect(source).toContain('background: var(--tasks-control)')
  })

  it('uses the established visually hidden utility for accessible control labels', () => {
    expect(pageSource).not.toContain('className="sr-only"')
    expect(pageSource.match(/className="visually-hidden"/g)).toHaveLength(4)
  })

  it('defines paired light and dark semantic text colors', () => {
    expect(source).toContain('--tasks-accent-text: light-dark(')
    expect(source).toContain('--tasks-danger-text: light-dark(')
    expect(source).toContain('--tasks-success-text: light-dark(')
    expect(source).toContain('--tasks-info-text: light-dark(')
    expect(source).toContain("html[data-theme='dark'] .workspace .sygtasks-card--urgent")
    expect(source).toContain("html[data-theme='dark'] .workspace .sygtasks-notice--error")
    expect(source).toContain("html[data-theme='dark'] .workspace .sygtasks-notice--success")
  })
})
