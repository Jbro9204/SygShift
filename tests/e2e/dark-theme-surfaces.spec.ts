import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

async function installSurfaceFixture(page: import('@playwright/test').Page) {
  await page.locator('#root').evaluate((root) => {
    document.documentElement.dataset.theme = 'dark'
    document.documentElement.style.colorScheme = 'dark'
    root.innerHTML = `
      <div class="app-shell">
        <aside class="sidebar"><div class="sidebar-brand"><img alt="SygShift" src="/brand/sygshift-logo.png" /></div></aside>
        <div class="workspace">
          <main id="main-content">
            <div class="page">
              <div class="page-intro"><div><p class="eyebrow">Theme review</p><h1>Dark surface verification</h1><p class="page-summary">Representative controls, cards, tables, and status messages remain readable.</p></div></div>
              <section class="metric-grid" aria-label="Summary metrics">
                <article class="metric"><div class="metric-heading">Ready</div><strong>24</strong><p>Records are available.</p></article>
                <article class="overview-employee-card"><h2>Employee card</h2><p>Compact supporting information.</p><a href="#details">View details</a></article>
              </section>
              <section class="panel">
                <div class="panel-heading"><h2>Controls and records</h2></div>
                <label class="field-label">Search<input placeholder="Search employees" /></label>
                <table><thead><tr><th>Employee</th><th>Status</th></tr></thead><tbody><tr><td>Jordan Brown</td><td><span class="status-pill status-pill--green">Ready</span></td></tr></tbody></table>
                <p class="form-feedback form-feedback--error" role="alert">An example issue needs attention.</p>
              </section>
              <div class="modal-backdrop" style="position:relative;inset:auto;margin-top:24px;padding:24px">
                <section aria-labelledby="modal-title" class="modal-dialog" role="dialog">
                  <h2 id="modal-title">Review details</h2>
                  <p>Modal information stays distinct from the page.</p>
                  <button class="secondary-button" type="button">Close</button>
                </section>
              </div>
            </div>
          </main>
        </div>
      </div>`
  })
}

test('representative full-site surfaces stay dark, contained, and accessible', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/')
  await installSurfaceFixture(page)

  for (const selector of ['.metric', '.overview-employee-card', '.panel', '.modal-dialog', '.field-label input']) {
    const channels = await page.locator(selector).evaluate((element) => {
      const match = getComputedStyle(element).backgroundColor.match(/\d+/g)
      return match ? match.slice(0, 3).map(Number) : []
    })
    expect(channels).toHaveLength(3)
    expect(Math.max(...channels)).toBeLessThan(80)
  }

  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440)
  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('dark-theme-surfaces.png'), fullPage: true })
})
