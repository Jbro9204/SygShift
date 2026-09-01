import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('Action Center history stays compact, readable, and contained', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.evaluate(() => {
    const rows = Array.from({ length: 10 }, (_, index) => `
      <article>
        <div class="action-history-list__main">
          <span class="action-history-type">${index % 2 ? 'Training' : 'Schedule'}</span>
          <strong>${index % 2 ? 'Annual safety review' : 'Schedule for week of 08/30/2026'}</strong>
          <small>Employee ${index + 1} · ${index % 2 ? 'Training version 2' : 'Revision 4 · 3 shifts'}</small>
        </div>
        <div><span>Outcome</span><span class="action-status action-status--completed">completed</span></div>
        <div><span>Resolved</span><strong>09/01/2026, 10:15 AM</strong><small>Employee ${index + 1}</small></div>
        <button class="secondary-button" type="button">View details</button>
      </article>`).join('')
    document.body.innerHTML = `
      <main class="page page--action-center">
        <header><p class="eyebrow">Employee actions</p><h1>Action Center</h1></header>
        <nav class="action-center-tabs" aria-label="Action Center views">
          <button type="button">Needs Attention <span>2</span></button>
          <button type="button">In Progress <span>1</span></button>
          <button class="is-active" aria-current="page" type="button">History</button>
        </nav>
        <section class="panel action-history-workspace">
          <div class="section-heading"><div><p class="eyebrow">Audit history</p><h2>Completed Action Center records</h2><p>Completed work leaves the active queue but remains permanently traceable here.</p></div></div>
          <div class="action-history-filters">
            <label class="action-history-search"><span>Search history</span><div><input aria-label="Search history" placeholder="Employee, action, note, or context" /></div></label>
            <label><span>Records</span><select aria-label="Records"><option>My history</option><option>Authorized team history</option></select></label>
            <label><span>Action type</span><select aria-label="Action type"><option>All actions</option></select></label>
            <label><span>Outcome</span><select aria-label="Outcome"><option>All outcomes</option></select></label>
            <label><span>Resolved from</span><input aria-label="Resolved from" type="date" /></label>
            <label><span>Resolved through</span><input aria-label="Resolved through" type="date" /></label>
          </div>
          <div class="action-history-list">${rows}</div>
          <div class="compact-pagination action-history-pagination">
            <span>Page 1 of 3 · 27 records</span>
            <label class="compact-page-size"><span>Rows</span><select aria-label="Rows"><option>10</option></select></label>
            <button class="secondary-button" disabled type="button">Previous</button>
            <button class="secondary-button" type="button">Next</button>
          </div>
        </section>
      </main>`
  })

  await expect(page.getByRole('navigation', { name: 'Action Center views' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'History' })).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('.action-history-list article')).toHaveCount(10)
  await expect(page.getByLabel('Rows')).toHaveValue('10')
  await expect(page.getByText('Page 1 of 3 · 27 records')).toBeVisible()

  const viewportWidth = page.viewportSize()?.width ?? 0
  const bodyWidth = await page.locator('body').evaluate((body) => body.scrollWidth)
  expect(bodyWidth).toBeLessThanOrEqual(viewportWidth)

  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('action-center-history.png'), fullPage: true })

  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
    document.documentElement.style.colorScheme = 'dark'
  })
  await expect(page.locator('.action-history-workspace')).toHaveCSS('background-color', 'rgb(23, 27, 31)')
  const darkAccessibility = await new AxeBuilder({ page }).analyze()
  expect(darkAccessibility.violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('action-center-history-dark.png'), fullPage: true })
})
