import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

const appCss = read('src/App.css')
const navigation = read('src/app/navigation.ts')
const patrolPage = read('src/pages/PatrolPage.tsx')
const router = read('src/app/router.tsx')
const schedulePage = read('src/pages/SchedulePage.tsx')
const timeExceptionsPage = read('src/time/TimeExceptionsPage.tsx')
const timePayrollPage = read('src/time/TimePayrollPage.tsx')

describe('reported interface cleanup', () => {
  it('keeps Dispatch phone coverage readable without shrinking the time range', () => {
    expect(schedulePage).toContain('shift-card__heading--dispatch')
    expect(appCss).toContain('.shift-card__heading--dispatch > strong')
    expect(appCss).toContain('word-break: normal')
    expect(appCss).toContain('.shift-card__heading--dispatch .shift-tag--dispatch')
  })

  it('uses one shared presentation gutter for the reported modal form families', () => {
    expect(appCss).toContain('.modal-dialog > .client-form')
    expect(appCss).toContain('.hr-file-editor-modal > form')
    expect(appCss).toContain('.hr-employment-dates-modal > form')
    expect(appCss).toContain('.modal-dialog > .supervisor-assignment-form')
    expect(appCss).toContain('.document-studio-modal > .document-studio-form')
    expect(appCss).toContain('margin: 22px var(--presentation-gutter) var(--presentation-gutter)')
  })

  it('gives payroll period shortcuts a visible selected state', () => {
    for (const page of [timeExceptionsPage, timePayrollPage]) {
      expect(page.includes('aria-pressed={completedSelected') || page.includes('aria-pressed={fromDate === completedPeriod.fromDate')).toBe(true)
      expect(page).toContain('Current open period')
    }
    expect(appCss).toContain(".payroll-period-controls__actions .time-button[aria-pressed='true']")
  })

  it('supports a direct Patrol Operations route instead of a missing page', () => {
    expect(router).toContain("path: 'patrol/:patrolTab'")
    expect(patrolPage).toContain("`/patrol/${next}`")
    expect(patrolPage).toContain("patrolTab === 'operations'")
  })

  it('consolidates the administration menu while preserving protected destinations', () => {
    expect(navigation).toContain("label: 'Users & Roles'")
    expect(navigation).toContain("path: '/administration/access'")
    expect(navigation).not.toContain("label: 'User Accounts'")
    expect(navigation).not.toContain("label: 'Roles & Permissions'")
    expect(router).toContain("path: 'administration/access'")
  })
})
