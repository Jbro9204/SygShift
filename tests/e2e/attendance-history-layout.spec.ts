import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark']) test(`Attendance filters, pagination, and period selector stay readable in ${theme} mode`, async ({ page }) => {
  await page.goto('/')
  await page.locator('html').evaluate((html, value) => { html.dataset.theme = value }, theme)
  await page.locator('#root').evaluate((root) => {
    root.innerHTML = `<main class="page page--reports" style="max-width:1200px;margin:auto;padding:16px">
      <section class="operations-panel reports-workspace-controls attendance-report-controls"><fieldset>
        <div class="reports-range"><label>From<input type="date" value="2026-08-30" /></label><label>Through<input type="date" value="2026-09-05" /></label></div>
        <div class="reports-filter-row"><label>Search attendance<input type="search" placeholder="Employee, location, or note" /></label><label>Occurrence type<select><option>All occurrence types</option></select></label><label>Review state<select><option>All review states</option></select></label></div>
      </fieldset></section>
      <section class="operations-panel reports-results attendance-report-results"><nav class="reports-pagination attendance-report-pagination" aria-label="Attendance pages"><label>Rows<select><option>10</option></select></label><span>Page 1 of 3</span><button class="secondary-button">Previous</button><button class="secondary-button">Next</button></nav></section>
      <section class="time-card"><label class="my-time-period-picker"><span>Pay period</span><select aria-label="Pay period"><option>Two periods ago · 08/09/2026 – 08/22/2026</option></select><small>History is for review. Your live clock is unchanged.</small></label></section>
    </main>`
  })
  const controls = page.locator('.attendance-report-controls')
  const fieldset = controls.locator('fieldset')
  expect((await fieldset.boundingBox())!.width / (await controls.boundingBox())!.width).toBeGreaterThan(.82)
  for (const element of await page.locator('.attendance-report-controls input, .attendance-report-controls select, .my-time-period-picker select').all()) {
    expect((await element.boundingBox())!.height).toBeGreaterThanOrEqual(40)
    expect(await element.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(2)
  }
  expect((await page.getByRole('navigation', { name: 'Attendance pages' }).boundingBox())!.height).toBeLessThan(135)
  expect(await page.locator('main').evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1)
  await expect(page.getByRole('combobox', { name: 'Pay period' })).toBeVisible()
})
