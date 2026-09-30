/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const readSource = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8')

const accessControl = readSource('src', 'pages', 'AccessControlPage.tsx')
const actionCenter = readSource('src', 'pages', 'ActionCenterPage.tsx')
const appShell = readSource('src', 'components', 'AppShell.tsx')
const employeeFile = readSource('src', 'pages', 'HrisEmployeeFilePage.tsx')
const onboarding = readSource('src', 'pages', 'HrisOnboardingPage.tsx')
const peopleWorkspace = readSource('src', 'pages', 'HrisPeopleWorkspacePage.tsx')
const sygsphere = readSource('src', 'pages', 'SygSpherePage.tsx')
const notifications = readSource('src', 'pages', 'NotificationsPage.tsx')

describe('workforce role label uniformity guardrails', () => {
  it('uses the canonical role options in onboarding and training', () => {
    expect(onboarding).toContain('<span>Primary workforce role</span>')
    expect(onboarding).toContain('workforceRoleLabel(prehire.role)')
    expect(onboarding).not.toContain('Schedule &amp; timekeeping role')
    expect(actionCenter).toContain('workforceRoleOptions.map((role)')
    expect(actionCenter).not.toContain("role.replace('_', ' ')")
  })

  it('distinguishes protected access roles from custom roles', () => {
    expect(accessControl).toContain("role.protected ? 'Protected access role' : 'Custom role'")
    expect(accessControl).toContain('workforceRoleLabel(role.baseAppRole)')
  })

  it('uses the canonical workforce-role fallback in employee-facing workspaces', () => {
    expect(appShell).toContain('workforceRoleLabel(accountSummary?.employment.primaryRole)')
    expect(employeeFile).toContain('workforceRoleLabel(record.primaryRole)')
    expect(peopleWorkspace).toContain('workforceRoleLabel(employee.primaryRole)')
    expect(sygsphere).toContain('workforceRoleLabel(person.role)')
    expect(notifications).toContain('workforceRoleLabel(employee.role)')
  })
})
