import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('supervision controls and the live-only roster stay readable and compact', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.locator('#root').evaluate((root) => {
    root.innerHTML = `
      <main class="page page--sygshift-time" aria-label="Current clocked-in employees">
        <h1>Currently Clocked In</h1>
        <section class="time-command-grid time-command-grid--live" aria-label="Current clock status summary">
          <article class="time-card time-metric time-metric--good"><div class="time-metric__top"><span>On Clock</span></div><strong>3</strong><small>All employees with an open clock session.</small></article>
          <article class="time-card time-metric time-metric--good"><div class="time-metric__top"><span>Working</span></div><strong>2</strong><small>Employees actively working.</small></article>
          <article class="time-card time-metric time-metric--warning"><div class="time-metric__top"><span>On Break</span></div><strong>1</strong><small>Employees whose open session is on break.</small></article>
          <article class="time-card time-metric"><div class="time-metric__top"><span>Needs Review</span></div><strong>0</strong><small>Current employee review items.</small></article>
        </section>
        <section class="time-card time-live-roster" aria-labelledby="roster-heading">
          <header class="time-section-header"><div><p class="eyebrow">Current status only</p><h2 id="roster-heading">Employees on the clock</h2><p>Historical punches and review tools are kept out of this view.</p></div></header>
          <div class="time-live-roster__controls">
            <label class="time-team-search"><span>Find employee</span><span class="time-team-search__field"><input placeholder="Name, username, or location" /></span></label>
            <label><span>Status</span><select><option>Everyone on clock</option></select></label>
            <label><span>Rows</span><select><option>10 per page</option></select></label>
          </div>
          <div class="time-live-list">
            <article class="time-live-row"><div class="time-live-row__identity"><strong>Zach Ward</strong><span>@zward · recruiting · salary</span></div><span class="time-status-badge time-status-badge--good">Working</span><div class="time-live-row__location"><span><strong>Administrative</strong><small>Supervisor: Jordan Brown</small></span></div><div class="time-live-row__time"><strong>2 hr 14 min</strong><span>Clocked in 09/02/2026, 8:00 AM CDT</span></div></article>
          </div>
        </section>
        <section class="workforce-toolbar" aria-label="Directory controls">
          <label class="search-field search-field--wide"><input aria-label="Search employees" placeholder="Search employees" /></label>
          <label class="select-field"><span>Workforce view</span><select><option>My Employees</option><option>All Employees</option><option>Unassigned</option><option>By Supervisor</option></select></label>
        </section>
      </main>`
  })

  await expect(page.getByText('Needs Review', { exact: true })).toBeVisible()
  const labelStyle = await page.getByText('Needs Review', { exact: true }).evaluate((element) => getComputedStyle(element).fontSize)
  expect(Number.parseFloat(labelStyle)).toBeGreaterThanOrEqual(15)
  await expect(page.getByText('Employees on the clock', { exact: true })).toBeVisible()
  await expect(page.getByRole('option', { name: 'My Employees' })).toHaveCount(1)

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)
  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('supervision-live-roster-layout.png'), fullPage: true })
})
