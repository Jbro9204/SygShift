import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('HR pagination is compact, anchored, and responsive', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim().length > 0)
  await page.locator('#root').evaluate((root) => {
    root.innerHTML = `
      <main class="page page--hr-automation" style="max-width:1180px;margin:24px auto">
        <section class="page-intro workforce-intro"><div><p class="eyebrow">HR &amp; Finance</p><h1>Talent Management</h1><p class="page-summary">Review goals, development plans, and performance records.</p></div></section>
        <section class="panel hr-automation-worklist">
          <div class="section-heading"><div><p class="eyebrow">Current work</p><h2>Talent records</h2></div></div>
          <div class="hr-automation-list">
            <article><div><strong>Performance review</strong><span>Jordan Brown · Due 09/18/2026</span></div><div><span class="action-status">In progress</span></div></article>
            <article><div><strong>Development plan</strong><span>Alex Employee · Due 09/24/2026</span></div><div><span class="action-status">Open</span></div></article>
          </div>
        </section>
        <nav aria-label="Talent records pages" class="hr-pagination">
          <div aria-live="polite" class="hr-pagination__summary"><span>Showing</span><strong>1–10</strong></div>
          <div class="hr-pagination__controls">
            <label><span>Rows per page</span><select aria-label="Talent records rows per page"><option>10</option></select></label>
            <button class="secondary-button" disabled type="button">Previous</button>
            <button class="secondary-button" type="button">Next</button>
          </div>
        </nav>
      </main>`
  })

  const pagination = page.getByRole('navigation', { name: 'Talent records pages' })
  const paginationBox = (await pagination.boundingBox())!
  const viewport = page.viewportSize()!
  expect(paginationBox.height).toBeLessThan(viewport.width > 720 ? 100 : 210)
  expect(paginationBox.x).toBeGreaterThanOrEqual(4)
  expect(paginationBox.x + paginationBox.width).toBeLessThanOrEqual(viewport.width - 4)
  await expect(pagination.getByText('1–10')).toBeVisible()

  for (const control of await pagination.locator('button, select').all()) {
    expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  }

  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('hr-pagination-layout.png'), fullPage: true })
})
