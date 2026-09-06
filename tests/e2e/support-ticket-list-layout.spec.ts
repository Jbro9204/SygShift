import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`support ticket filters and empty pagination stay compact in ${theme} mode`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 900, height: 820 })
    await page.goto('/')
    await page.evaluate((selectedTheme) => {
      document.documentElement.dataset.theme = selectedTheme
      document.documentElement.style.colorScheme = selectedTheme
    }, theme)
    await page.locator('#root').evaluate((root) => {
      root.innerHTML = `
        <main class="page" style="max-width:880px;margin:24px auto">
          <h1 style="position:absolute;left:-10000px">Support Tickets</h1>
          <section class="support-board">
            <section class="support-list-panel">
              <div class="support-list-toolbar">
                <label class="support-search">Search tickets<div><svg aria-hidden="true" width="18" height="18"></svg><input aria-label="Search tickets" placeholder="Ticket number or subject" /></div></label>
                <label>Status<select aria-label="Status"><option>Open tickets</option></select></label>
              </div>
              <div class="data-state"><div class="data-state__icon" aria-hidden="true">!</div><div><h2>No support tickets match</h2><p>Change the filters or submit a new request.</p></div></div>
              <nav aria-label="Support ticket pages" class="communications-pagination communications-pagination--compact">
                <span>Page <strong>1</strong> of <strong>1</strong> · <strong>0</strong> tickets</span>
                <label>Rows<select aria-label="Rows per page"><option>10</option></select></label>
                <button class="secondary-button" disabled>Previous</button><button class="secondary-button" disabled>Next</button>
              </nav>
            </section>
            <section class="support-detail-panel"></section>
          </section>
        </main>`
    })

    const toolbar = page.locator('.support-list-toolbar')
    const emptyState = page.locator('.support-list-panel > .data-state')
    const pagination = page.getByRole('navigation', { name: 'Support ticket pages' })
    expect((await toolbar.boundingBox())!.height).toBeLessThan(100)
    expect((await emptyState.boundingBox())!.height).toBeLessThanOrEqual(180)
    expect((await pagination.boundingBox())!.height).toBeLessThanOrEqual(70)
    expect((await page.getByLabel('Search tickets').boundingBox())!.height).toBeGreaterThanOrEqual(40)
    expect((await page.getByLabel('Status').boundingBox())!.height).toBeGreaterThanOrEqual(40)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)

    const accessibility = await new AxeBuilder({ page }).analyze()
    expect(accessibility.violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`support-ticket-empty-${theme}.png`), fullPage: true })
  })
}
