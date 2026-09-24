import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

async function installAccountReportFixture(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    document.body.innerHTML = `<main style="max-width:1372px;margin:24px auto;padding:0 20px 48px">
      <section class="operations-panel reports-workspace-heading account-activity-heading"><a class="secondary-button reports-back" href="#library">Back to report library</a><div><p class="eyebrow">Protected HR &amp; security reporting</p><h1>User Account &amp; Sign-In Activity</h1><p>Review account readiness, completed sign-ins, MFA, sessions, and roles.</p></div></section>
      <section class="operations-panel reports-workspace-controls account-activity-controls" aria-label="User account activity report controls">
        <label class="reports-search"><span>Search employees</span><span class="reports-search-input"><span aria-hidden="true">⌕</span><input aria-label="Search employees" placeholder="Name, employee number, username, email, title, or role" type="search"></span></label>
        <div class="reports-filter-row account-activity-filter-row"><label><span>Employment</span><select><option>All employees</option></select></label><label><span>Account</span><select><option>All account states</option></select></label><label><span>Sign-in activity</span><select><option>All sign-in states</option></select></label><label><span>MFA</span><select><option>All MFA states</option></select></label><label><span>Role</span><select><option>All roles</option></select></label><label><span>Sign-in source</span><select><option>All sources</option></select></label><label><span>Inactive after</span><select><option>30 days</option></select></label></div>
        <div class="account-activity-rule"><span aria-hidden="true">✓</span><div><strong>Completed sign-ins only</strong><span>A password attempt does not count.</span></div></div>
      </section>
      <section class="operations-metrics reports-metric-grid account-activity-metrics" aria-label="User account activity totals">${['Matching employees','Active accounts','Never signed in','Pending setup','MFA attention','Security exceptions'].map((label, index) => `<article><span>${label}</span><strong>${index + 1}</strong><small>Current filters</small></article>`).join('')}</section>
      <section class="operations-panel reports-results account-activity-results"><div class="reports-section-heading"><div><p class="eyebrow">Account readiness</p><h2>39 matching employees</h2><p>Use the Employee File or User Accounts for changes.</p></div><div class="account-activity-export-actions"><button class="primary-action">Export Excel</button><button class="secondary-button">Export PDF</button></div></div>
        <div class="reports-result-list account-activity-list"><article class="reports-result-card account-activity-row"><dl class="reports-result-summary account-activity-summary"><div><dt>Employee</dt><dd>Jordan Example<small>SYG-1000 · @jexample</small></dd></div><div><dt>Account</dt><dd>Active<small>active</small></dd></div><div><dt>Sign-in activity</dt><dd>Recently active<small>09/24/2026, 8:30 AM MDT</small></dd></div><div><dt>MFA</dt><dd>Enrolled<small>1 active session</small></dd></div><div><dt>Next action</dt><dd>No action required<small>No security exception</small></dd></div></dl><button class="secondary-button">View details</button></article></div>
      </section>
    </main>`
  })
}

async function installOnboardingFixture(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    document.body.innerHTML = `<div class="modal-backdrop"><section aria-labelledby="onboarding-title" aria-modal="true" class="modal-dialog modal-dialog--hr-onboarding" role="dialog"><header class="modal-dialog__heading"><div><h2 id="onboarding-title">Start employee onboarding</h2><p>Create a new pre-hire or use an existing employee.</p></div><button aria-label="Close">×</button></header><form class="hr-onboarding-form">
      <ol class="hr-onboarding-steps" aria-label="Onboarding setup progress"><li class="is-current" aria-current="step"><span>1</span><strong>Employee</strong></li><li><span>2</span><strong>Employment</strong></li><li><span>3</span><strong>Requirements</strong></li><li><span>4</span><strong>Review</strong></li></ol>
      <fieldset><legend>Who are you onboarding?</legend><div class="hr-onboarding-mode-picker" role="radiogroup" aria-label="Employee source"><button aria-pressed="true" class="is-selected" type="button"><span aria-hidden="true">+</span><span><strong>New employee</strong><small>Create one protected identity and onboarding case.</small></span></button><button aria-pressed="false" type="button"><span aria-hidden="true">✓</span><span><strong>Already in SygShift</strong><small>Attach onboarding without duplicating the employee.</small></span></button></div><div class="hr-onboarding-form-grid hr-onboarding-form-grid--three"><label><span>Legal first name</span><input value="Jordan"></label><label><span>Middle name</span><input></label><label><span>Legal last name</span><input value="Example"></label><label><span>Personal email</span><input type="email" value="jordan@example.com"></label><label><span>Mobile phone</span><input type="tel"></label></div></fieldset>
      <div class="modal-actions hr-onboarding-wizard-actions"><button class="secondary-button" type="button">Cancel</button><button class="primary-action" type="button">Continue</button></div>
    </form></section></div>`
  })
}

for (const width of [1280, 390]) {
  test(`account activity report remains polished and usable at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 1400 : 1000 })
    await page.goto('/')
    await installAccountReportFixture(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    for (const control of await page.locator('.account-activity-controls input, .account-activity-controls select').all()) expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(42)
    await expect(page.getByRole('button', { name: 'Export Excel' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Export PDF' })).toBeVisible()
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`account-activity-${width}.png`), fullPage: true })
  })

  test(`onboarding wizard remains usable at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 900 : 900 })
    await page.goto('/')
    await installOnboardingFixture(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Already in SygShift' })).toBeVisible()
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`onboarding-wizard-${width}.png`), fullPage: true })
  })
}

