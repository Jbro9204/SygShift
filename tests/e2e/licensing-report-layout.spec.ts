import { expect, test } from '@playwright/test'

test('Guard Licensing Status report stays compact, readable, and contained', async ({ page }, testInfo) => {
  await page.goto('/')

  await page.locator('#root').evaluate((root) => {
    const statusCards = [
      ['Employees shown', '18', 'All license states', ''],
      ['Current', '11', 'Open filtered list', 'reports-licensing-status--green'],
      ['Expiring soon', '3', 'Open filtered list', 'reports-licensing-status--yellow'],
      ['Expired', '1', 'Open filtered list', 'reports-licensing-status--red'],
      ['Not licensed', '2', 'Open filtered list', 'reports-licensing-status--red'],
      ['Pending review', '1', 'Open filtered list', 'reports-licensing-status--yellow'],
      ['Restricted', '0', 'Open filtered list', 'reports-licensing-status--red'],
    ]

    root.innerHTML = `
      <main style="max-width: 1372px; margin: 32px auto; padding: 0 20px;">
        <section class="operations-panel reports-workspace-heading reports-licensing-heading">
          <button class="secondary-button reports-back" type="button">Back to report library</button>
          <div><p class="eyebrow">Licensing report</p><h1>Guard Licensing Status</h1><p>See who is currently licensed, approaching expiration, expired, pending review, restricted, or missing a required guard license.</p></div>
          <button class="primary-action" type="button">Download Excel report</button>
        </section>
        <section class="reports-licensing-status-grid" aria-label="Guard license status summary">
          ${statusCards.map(([label, count, note, tone], index) => `<button class="${tone}${index === 0 ? ' is-active' : ''}" type="button"><span>${label}</span><strong>${count}</strong><small>${note}</small></button>`).join('')}
        </section>
        <section class="operations-panel reports-workspace-controls reports-licensing-controls" aria-label="Licensing report filters">
          <label class="reports-search"><span>Search</span><span class="reports-search-input"><input aria-label="Search" placeholder="Legal name, employee ID, license number, or credential" /></span></label>
          <div class="reports-filter-row">
            <label><span>Employees</span><select><option>Guards only</option></select></label>
            <label><span>Employment</span><select><option>Active</option></select></label>
            <label><span>License status</span><select><option>All license statuses</option></select></label>
            <label><span>Credential type</span><select><option>All credential types</option></select></label>
            <label><span>Rows</span><select><option>10</option></select></label>
          </div>
        </section>
        <section class="operations-panel reports-results">
          <div class="reports-section-heading"><div><p class="eyebrow">Results</p><h2>18 employees</h2><p>Legal names only. Statuses come from the same protected rules used by Licensing Center.</p></div><button class="secondary-button reports-canonical-link" type="button">Open Licensing Center</button></div>
          <div class="reports-result-list">
            <article class="reports-result-card reports-licensing-result reports-licensing-result--red">
              <dl class="reports-result-summary reports-licensing-summary">
                <div><dt>Employee</dt><dd>Sample Employee<small>SYG-1000 · Security Officer</small></dd></div>
                <div><dt>Guard license</dt><dd><span class="reports-license-pill reports-license-pill--red">Expired</span><small>Colorado Guard License</small></dd></div>
                <div><dt>License number</dt><dd>G-1000</dd></div>
                <div><dt>Expiration</dt><dd>08/15/2026<small>17 days overdue</small></dd></div>
                <div><dt>Work eligibility</dt><dd>Restricted<small>1 required credential missing</small></dd></div>
              </dl>
              <button class="secondary-button" type="button">View details</button>
            </article>
          </div>
        </section>
      </main>`
  })

  const viewport = page.viewportSize()
  expect(viewport).not.toBeNull()

  for (const region of [page.getByRole('region', { name: 'Guard license status summary' }), page.getByRole('region', { name: 'Licensing report filters' })]) {
    const overflow = await region.evaluate((element) => element.scrollWidth - element.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)
  }

  const statusButtons = await page.getByRole('region', { name: 'Guard license status summary' }).getByRole('button').all()
  expect(statusButtons).toHaveLength(7)
  for (const button of statusButtons) {
    const box = await button.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.height).toBeGreaterThanOrEqual(80)
  }

  const filters = page.getByRole('region', { name: 'Licensing report filters' })
  for (const control of await filters.locator('input, select').all()) {
    const box = await control.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.height).toBeGreaterThanOrEqual(42)
  }

  const documentOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(documentOverflow).toBeLessThanOrEqual(1)

  const resultsBox = await page.locator('.reports-results').boundingBox()
  expect(resultsBox).not.toBeNull()
  expect(resultsBox!.x).toBeGreaterThanOrEqual(4)
  expect(resultsBox!.x + resultsBox!.width).toBeLessThanOrEqual(viewport!.width - 4)

  await page.screenshot({ path: testInfo.outputPath('guard-licensing-status-report.png'), fullPage: true })
})
