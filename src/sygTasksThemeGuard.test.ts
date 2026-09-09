import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(join(process.cwd(), 'src/styles/sygtasks.css'), 'utf8')
const page = readFileSync(join(process.cwd(), 'src/pages/SygTasksPage.tsx'), 'utf8')
const elements = readFileSync(join(process.cwd(), 'src/components/sygtasks/SygTasksElements.tsx'), 'utf8')

describe('SygTasks visual and accessibility contract', () => {
  it('uses the approved SygTasks palette with a complete, readable dark theme', () => {
    expect(styles).toContain('--tasks-bg: #f7f4ec')
    expect(styles).toContain('--tasks-ink: #0c0d0d')
    expect(styles).toContain('--tasks-gold: #e3ad3b')
    expect(styles).toContain('--tasks-champagne: #f5d986')
    expect(styles).toContain('--tasks-silver: #bfc1c2')
    expect(styles).toMatch(/html\[data-theme='dark'\][\s\S]*--tasks-bg: #0c0d0d[\s\S]*--tasks-ink: #f7f4ec/)
    expect(styles).not.toContain('var(--text,')
    expect(styles).not.toContain('var(--muted-text,')
  })

  it('shares semantic theme tokens across workspace, loading, unavailable, and dialog surfaces', () => {
    expect(styles).toMatch(/\.sygtasks-workspace,\s*\.sygtasks-loading,\s*\.sygtasks-unavailable,\s*\.sygtasks-dialog,\s*\.sygtasks-detail-dialog\s*\{/)
    expect(styles).toContain('color: var(--tasks-ink)')
    expect(styles).toContain('background: var(--tasks-control)')
    expect(styles).toContain("html[data-theme='dark'] .sygtasks-notice--success")
    expect(styles).toContain("html[data-theme='dark'] .sygtasks-notice--error")
  })

  it('uses the approved brand assets in the header and resilient loading states', () => {
    expect(elements).toContain('src="/branding/sygtasks-logo.png"')
    expect(elements).toContain('SYGSHIFT WORK MANAGEMENT')
    expect(elements).toContain('Organize · Own · Progress · Complete')
    expect(page.match(/src="\/branding\/sygtasks-emblem\.png"/g)).toHaveLength(2)
  })

  it('keeps controls touch-sized, rounded, keyboard-visible, and responsive through mobile', () => {
    expect(styles).toMatch(/\.sygtasks-button\s*\{[\s\S]*?min-height: 44px/)
    expect(styles).toMatch(/\.sygtasks-icon-button\s*\{[^}]*width: 44px[^}]*height: 44px/)
    expect(styles).toContain(':focus-visible')
    expect(styles).toContain('@media (max-width: 1180px)')
    expect(styles).toContain('@media (max-width: 980px)')
    expect(styles).toContain('@media (max-width: 480px)')
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('keeps table controls explicitly labelled and hides only redundant visual text', () => {
    expect(elements.match(/className="visually-hidden"/g)).toHaveLength(3)
    expect(elements).toContain('Status for {task.title}')
    expect(elements).toContain('<span className="visually-hidden">Actions</span>')
    expect(elements).not.toContain('className="sr-only"')
  })

  it('contains horizontal board overflow instead of widening the application shell', () => {
    expect(styles).toMatch(/\.sygtasks-kanban-shell\s*\{[^}]*max-width: 100%[^}]*overflow: hidden/)
    expect(styles).toMatch(/\.sygtasks-kanban\s*\{[^}]*overflow-x: auto/)
    expect(styles).toMatch(/\.sygtasks-workspace\s*\{[^}]*overflow-x: clip/)
  })
})
