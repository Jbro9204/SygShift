import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

async function installScheduledOvertimeFixture(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    document.body.innerHTML = `
      <main style="max-width: 1372px; margin: 24px auto; padding: 0 20px 40px;">
        <section class="operations-panel reports-workspace-heading reports-overtime-heading">
          <div class="reports-overtime-heading__main">
            <a class="reports-overtime-back-link" href="#reports">← Back to report library</a>
            <div class="reports-overtime-heading__copy">
              <p class="eyebrow">Workforce planning</p>
              <h1>Scheduled Overtime Forecast</h1>
              <p>See who is scheduled above 40 hours before the week begins, what assignments create the total, and where armed Flex capacity may exist.</p>
            </div>
          </div>
          <button class="primary-action" type="button">↓ Download Excel report</button>
        </section>

        <section class="operations-panel reports-workspace-controls reports-overtime-controls" aria-label="Scheduled overtime forecast controls">
          <div class="reports-overtime-filter-grid">
            <label class="reports-overtime-week"><span>Schedule week</span><input type="date" value="2026-09-06" /></label>
            <label class="reports-search"><span>Search</span><span class="reports-search-input"><span aria-hidden="true">⌕</span><input placeholder="Employee, ID, title, site, or approval note" type="search" /></span></label>
            <label><span>Coverage</span><select><option>All projected overtime</option></select></label>
          </div>
          <div class="reports-overtime-schedule-context" aria-label="Selected schedule revision">
            <svg aria-hidden="true" height="19" viewBox="0 0 24 24" width="19"><rect fill="none" height="16" rx="2" stroke="currentColor" width="18" x="3" y="5"></rect></svg>
            <div><strong>Sep 6, 2026 through Sep 12, 2026</strong><span>Published schedule · Revision 3</span></div>
          </div>
          <div class="reports-export-note"><span aria-hidden="true">◈</span><span>Forecast uses assigned standard shifts. Supplemental Dispatch phone duty is excluded, and actual payroll overtime can change with worked time and corrections.</span></div>
        </section>

        <section class="operations-metrics reports-metric-grid reports-overtime-metrics" aria-label="Scheduled overtime summary">
          <article><span>Projected overtime</span><strong>4</strong><small>Employees above 40 scheduled hours</small></article>
          <article><span>Armed overtime</span><strong>2</strong><small>Overtime employees with armed coverage</small></article>
          <article><span>Total projected OT</span><strong>45.00 hrs</strong><small>Across the selected schedule revision</small></article>
          <article><span>Armed Flex capacity</span><strong>0</strong><small>Candidates requiring availability review</small></article>
        </section>
      </main>`
  })
}

for (const width of [1440, 1024, 390]) {
  test(`scheduled overtime report is balanced and contained at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 1100 : 900 })
    await page.goto('/')
    await installScheduledOvertimeFixture(page)

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await expect(page.getByRole('link', { name: 'Back to report library' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Download Excel report' })).toBeVisible()

    for (const control of await page.getByRole('region', { name: 'Scheduled overtime forecast controls' }).locator('input, select').all()) {
      const box = await control.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.height).toBeGreaterThanOrEqual(44)
    }

    const accessibility = await new AxeBuilder({ page }).analyze()
    expect(accessibility.violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`scheduled-overtime-${width}.png`), fullPage: true })
  })
}

test('scheduled overtime report remains legible in dark mode', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
    document.documentElement.style.colorScheme = 'dark'
  })
  await installScheduledOvertimeFixture(page)
  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('scheduled-overtime-dark.png'), fullPage: true })
})
