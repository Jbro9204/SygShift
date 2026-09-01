import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

async function installSystemFixture(page: import('@playwright/test').Page, theme: 'dark' | 'light' = 'dark') {
  await page.locator('#root').evaluate((root, selectedTheme) => {
    document.documentElement.dataset.theme = selectedTheme
    document.documentElement.style.colorScheme = selectedTheme
    const fixtureStyle = document.createElement('style')
    fixtureStyle.textContent = '.route-error { display: none !important; }'
    document.head.append(fixtureStyle)
    root.innerHTML = `
      <div class="app-shell">
        <aside class="sidebar"><div class="sidebar-brand"><img alt="SygShift" src="/brand/sygshift-logo.png" /></div></aside>
        <div class="workspace">
          <main id="main-content">
            <div class="page dark-system-fixture">
              <section class="page-intro communications-hero">
                <div><p class="eyebrow">Communication Center</p><h1>System-wide dark theme</h1><p class="page-summary">Cards, controls, lists, and workflows use one restrained dark surface system.</p></div>
                <div class="communications-hero__actions"><button class="secondary-button">New banner alert</button><button class="primary-action">New announcement</button></div>
              </section>

              <section class="communications-summary" aria-label="Communication totals">
                <article><span>Queued</span><strong>0</strong><small>Jobs ready to process</small></article>
                <article><span>Delivered</span><strong>102</strong><small>Completed deliveries</small></article>
                <article class="communications-summary--danger"><span>Failed</span><strong>2</strong><small>Needs attention</small></article>
              </section>
              <nav class="communications-tabs" aria-label="Announcement views"><button class="is-active">Overview</button><button>Banner alerts</button><button>History &amp; acknowledgments</button></nav>

              <section class="hr-people-summary" aria-label="HR totals">
                <article><span>Active</span><strong>46</strong><small>Current employees</small></article>
                <article><span>Onboarding</span><strong>2</strong><small>Joining the workforce</small></article>
                <article><span>On leave</span><strong>0</strong><small>Current leave status</small></article>
                <article class="attention"><span>Needs attention</span><strong>8</strong><small>Record-readiness signals</small></article>
              </section>

              <section class="time-operations-metrics" aria-label="Time totals">
                <article><span>Clocked in</span><strong>12</strong><small>Employees working</small></article>
                <article><span>Exceptions</span><strong>3</strong><small>Items requiring review</small></article>
                <article><span>Requests</span><strong>1</strong><small>Pending approval</small></article>
                <article><span>Ready</span><strong>44</strong><small>Clean time cards</small></article>
              </section>

              <section class="licensing-summary-grid" aria-label="Licensing totals">
                <button class="licensing-summary-card licensing-summary-card--green"><span>Current</span><strong>38</strong><small>Valid credentials</small></button>
                <button class="licensing-summary-card licensing-summary-card--yellow"><span>Expiring</span><strong>5</strong><small>Renewal window</small></button>
                <button class="licensing-summary-card licensing-summary-card--red"><span>Expired</span><strong>2</strong><small>Action required</small></button>
                <button class="licensing-summary-card"><span>Missing</span><strong>1</strong><small>No credential</small></button>
                <button class="licensing-summary-card"><span>Not applicable</span><strong>4</strong><small>Non-guard roles</small></button>
              </section>

              <section class="user-admin-summary" aria-label="Account totals">
                <article><span>Total people</span><strong>74</strong><small>Employee records</small></article>
                <article><span>Active</span><strong>46</strong><small>Eligible for access</small></article>
                <article class="is-attention"><span>Need accounts</span><strong>2</strong><small>Active without login</small></article>
                <article><span>Admins</span><strong>3</strong><small>Highest access</small></article>
              </section>

              <section class="panel dark-system-fixture__controls">
                <div class="panel-heading"><h2>Controls, records, and status</h2><a href="#details">View details</a></div>
                <div class="form-grid form-grid--two-columns">
                  <label>Search<input placeholder="Search employees" /></label>
                  <label>Status<select><option>All statuses</option></select></label>
                </div>
                <label class="field-stack">Required explanation<textarea>Document the reason for this change.</textarea></label>
                <table><thead><tr><th>Employee</th><th>Status</th><th>Action</th></tr></thead><tbody><tr><td>Jordan Brown</td><td><span class="status-pill status-pill--green">Active</span></td><td><button class="secondary-button">Review</button></td></tr><tr><td>Roman Timoteo</td><td><span class="status-pill status-pill--gold">Pending</span></td><td><button class="quiet-danger-button">Remove</button></td></tr></tbody></table>
                <p class="form-feedback form-feedback--error" role="alert">A sample issue needs attention.</p>
              </section>

              <div class="modal-backdrop dark-system-fixture__backdrop" style="position:relative;inset:auto;margin-top:20px;padding:0">
                <section aria-labelledby="fixture-dialog-title" class="modal-dialog" role="dialog">
                  <div class="modal-dialog__heading"><div><h2 id="fixture-dialog-title">Review employee record</h2><p>Modal content remains readable and contained.</p></div><button aria-label="Close" class="modal-close">×</button></div>
                  <div class="request-form"><label class="field-stack">Reason<textarea>Required audit note.</textarea></label><div class="modal-actions"><button class="secondary-button">Cancel</button><button class="primary-action">Save changes</button></div></div>
                </section>
              </div>
            </div>
          </main>
        </div>
      </div>`
  }, theme)
}

function rgbChannels(value: string) {
  const match = value.match(/[\d.]+/g)
  return match ? match.slice(0, 3).map(Number) : []
}

test('shared component families remain dark, readable, and contained', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.waitForTimeout(300)
  await installSystemFixture(page)

  const surfaceSelectors = [
    '.communications-summary > article:first-child',
    '.communications-tabs',
    '.communications-tabs .is-active',
    '.hr-people-summary > article:first-child',
    '.time-operations-metrics > article:first-child',
    '.licensing-summary-card:first-child',
    '.user-admin-summary',
    '.panel',
    'input',
    'select',
    'textarea',
    '.modal-dialog',
  ]
  for (const selector of surfaceSelectors) {
    const background = await page.locator(selector).first().evaluate((element) => getComputedStyle(element).backgroundColor)
    const channels = rgbChannels(background)
    expect(channels, `${selector} should resolve to an opaque dark surface`).toHaveLength(3)
    expect(Math.max(...channels), `${selector} resolved to ${background}`).toBeLessThan(100)
  }

  const overflowState = await page.evaluate(() => ({
    amount: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    offenders: [...document.querySelectorAll('body *')]
      .map((element) => ({ className: element.className, right: element.getBoundingClientRect().right }))
      .filter((item) => item.right > document.documentElement.clientWidth + 1)
      .slice(0, 8),
  }))
  expect(overflowState.amount, JSON.stringify(overflowState.offenders)).toBeLessThanOrEqual(1)

  const accessibility = await new AxeBuilder({ page }).include('.dark-system-fixture').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(accessibility.violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('dark-theme-system.png'), fullPage: true })
})

test('the system-wide correction preserves light-mode surfaces', async ({ page }) => {
  await page.goto('/')
  await page.waitForTimeout(300)
  await installSystemFixture(page, 'light')

  for (const selector of ['.communications-summary > article:first-child', '.hr-people-summary > article:first-child', '.panel', 'input', '.modal-dialog']) {
    const background = await page.locator(selector).first().evaluate((element) => getComputedStyle(element).backgroundColor)
    const channels = rgbChannels(background)
    expect(channels, `${selector} should resolve to an opaque light surface`).toHaveLength(3)
    expect(Math.min(...channels), `${selector} resolved to ${background}`).toBeGreaterThan(225)
  }
})
