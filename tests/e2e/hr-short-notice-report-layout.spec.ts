import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

async function installReportLibraryFixture(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    document.body.innerHTML = `<main style="max-width:1372px;margin:24px auto;padding:0 20px 48px"><h1>Reports</h1>
      <section class="reports-catalog" aria-labelledby="catalog-title">
        <div class="reports-section-heading"><div><p class="eyebrow">Report library</p><h2 id="catalog-title">Choose one report</h2><p>Each report opens in a focused, paginated workspace.</p></div></div>
        <div class="reports-report-grid">
          <article class="reports-report-card"><div class="reports-report-card__copy"><p class="eyebrow">HR attendance</p><h3>Short-Notice Call-Outs</h3><p>Identify employees who called out with less than four hours' notice, including no-call/no-show records and HR review status.</p></div><a class="secondary-button reports-report-card__action" href="#short">Open report</a></article>
          <article class="reports-report-card"><div class="reports-report-card__copy"><p class="eyebrow">Workforce planning</p><h3>Scheduled Overtime Forecast</h3><p>See who is scheduled above 40 hours and where qualified Flex capacity may exist.</p></div><a class="secondary-button reports-report-card__action" href="#overtime">Open report</a></article>
          <article class="reports-report-card"><div class="reports-report-card__copy"><p class="eyebrow">Client operations</p><h3>Client Portfolio &amp; Activity</h3><p>Review client status, linked sites, contacts, documents, shifts, patrol hits, incidents, and service history.</p></div><a class="secondary-button reports-report-card__action" href="#clients">Open report</a></article>
          <article class="reports-report-card"><div class="reports-report-card__copy"><p class="eyebrow">Patrol operations</p><h3>Patrol Activity</h3><p>Review required, completed, missed, makeup, extra, incident, location, and protected-evidence activity.</p></div><a class="secondary-button reports-report-card__action" href="#patrol">Open report</a></article>
          <article class="reports-report-card"><div class="reports-report-card__copy"><p class="eyebrow">Licensing &amp; credentials</p><h3>Guard Licensing Status</h3><p>See who is licensed, expiring, expired, pending review, restricted, or missing a required license.</p></div><a class="secondary-button reports-report-card__action" href="#licensing">Open report</a></article>
          <article class="reports-report-card"><div class="reports-report-card__copy"><p class="eyebrow">Time &amp; attendance</p><h3>Timekeeping Exceptions</h3><p>Review unresolved timekeeping exceptions and their current decision status.</p></div><a class="secondary-button reports-report-card__action" href="#time">Open report</a></article>
        </div>
      </section>
    </main>`
  })
}

async function installShortNoticeFixture(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    document.body.innerHTML = `<main style="max-width:1372px;margin:24px auto;padding:0 20px 48px">
      <section class="operations-panel reports-workspace-heading short-notice-heading"><a class="secondary-button reports-back" href="#library">Back to report library</a><div><p class="eyebrow">Protected HR reporting</p><h1>Short-Notice Call-Outs</h1><p>Employees who provided less than four hours' notice before a scheduled shift.</p></div></section>
      <section class="operations-panel reports-workspace-controls short-notice-controls" aria-label="Short-notice call-out report controls">
        <div class="reports-range"><label><span>From</span><input type="date" value="2026-09-01" /></label><label><span>Through</span><input type="date" value="2026-09-21" /></label></div>
        <label class="reports-search"><span>Search</span><span class="reports-search-input"><span aria-hidden="true">⌕</span><input aria-label="Search employees" placeholder="Employee, number, client, site, or receiver" type="search" /></span></label>
        <div class="reports-filter-row short-notice-filter-row"><label><span>Notice window</span><select><option>All under four hours</option></select></label><label><span>Occurrence</span><select><option>All occurrences</option></select></label><label><span>HR review</span><select><option>All review outcomes</option></select></label><label><span>Coverage result</span><select><option>All coverage results</option></select></label></div>
        <div class="short-notice-rule"><span aria-hidden="true">✓</span><div><strong>Four-hour policy rule</strong><span>Flag when scheduled start minus actual call-received time is less than 240 minutes.</span></div></div>
      </section>
      <section class="operations-metrics reports-metric-grid short-notice-metrics" aria-label="Short-notice call-out totals"><article><span>Short-notice events</span><strong>12</strong><small>Less than four hours</small></article><article><span>After shift start</span><strong>2</strong><small>Includes late reports</small></article><article><span>No-call / no-show</span><strong>1</strong><small>Separate severe category</small></article><article><span>Coverage unresolved</span><strong>3</strong><small>Current recorded status</small></article><article><span>Repeat employees</span><strong>2</strong><small>More than one event</small></article></section>
      <section class="operations-panel reports-results short-notice-results"><div class="reports-section-heading"><div><p class="eyebrow">HR attendance review</p><h2>12 matching events</h2><p>This report documents notice timing and operational impact.</p></div><div class="short-notice-export-actions"><button class="primary-action">Export Excel</button><button class="secondary-button">Export PDF</button></div></div>
        <div class="reports-result-list short-notice-list"><article class="reports-result-card short-notice-row"><dl class="reports-result-summary short-notice-summary"><div><dt>Work date</dt><dd>09/21/2026</dd></div><div><dt>Employee</dt><dd>Alex Guard<small>SYG-1001</small></dd></div><div><dt>Notice</dt><dd>1 hr 59 min</dd></div><div><dt>Shift</dt><dd>09/21/2026, 6:00 PM MDT</dd></div><div><dt>Site / post</dt><dd>Main Campus / Front Desk</dd></div><div><dt>Coverage</dt><dd>Coverage pending</dd></div></dl><button class="secondary-button">View details</button></article></div>
      </section>
    </main>`
  })
}

for (const theme of ['light', 'dark']) {
  test(`report library cards are uniform in ${theme} mode`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/')
    await page.locator('html').evaluate((html, value) => { html.dataset.theme = value }, theme)
    await installReportLibraryFixture(page)

    const heights = await page.locator('.reports-report-card').evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().height))
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(2)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280)
    expect((await page.locator('.reports-report-grid').evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(' ').length))).toBe(3)
    const accessibility = await new AxeBuilder({ page }).analyze()
    expect(accessibility.violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`report-library-${theme}.png`), fullPage: true })
  })
}

for (const width of [1280, 390]) {
  test(`short-notice HR report stays usable at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 1250 : 1000 })
    await page.goto('/')
    await installShortNoticeFixture(page)

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    for (const control of await page.locator('.short-notice-controls input, .short-notice-controls select').all()) {
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(40)
    }
    await expect(page.getByRole('button', { name: 'Export Excel' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Export PDF' })).toBeVisible()
    const accessibility = await new AxeBuilder({ page }).analyze()
    expect(accessibility.violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`short-notice-${width}.png`), fullPage: true })
  })
}
