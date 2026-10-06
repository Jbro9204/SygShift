import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

const viewportCases = [
  { height: 1000, label: 'wide desktop', width: 1440 },
  { height: 600, label: 'small laptop and high zoom', width: 800 },
  { height: 844, label: 'phone', width: 390 },
  { height: 720, label: 'narrow phone', width: 320 },
] as const

async function installWorkforceActivityFixture(page: Page) {
  await page.goto('/')
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim().length > 0)
  await page.locator('#root').evaluate((root) => {
    const fixtureRoot = root.cloneNode(false) as HTMLElement
    root.replaceWith(fixtureRoot)
    fixtureRoot.innerHTML = `
      <main class="page page--reports">
        <div class="workforce-activity-workspace">
          <section class="operations-panel reports-workspace-heading workforce-activity-heading">
            <a class="secondary-button reports-back" href="#report-library">Back to report library</a>
            <div>
              <p class="eyebrow">Daily workforce reporting</p>
              <h1>Workforce Activity</h1>
              <p>Start with one operational day to see who worked and where, or expand to a date range for a broader schedule comparison.</p>
            </div>
          </section>

          <section class="operations-panel workforce-activity-day-panel" aria-label="Workforce activity day">
            <div class="workforce-activity-scope" aria-label="Date scope">
              <button aria-pressed="true" class="workforce-activity-scope__button workforce-activity-scope__button--active" type="button">One day</button>
              <button aria-pressed="false" class="workforce-activity-scope__button" type="button">Date range</button>
            </div>
            <div class="workforce-activity-date-controls">
              <div class="workforce-activity-day-picker">
                <button aria-label="Previous day" class="secondary-button" type="button"><span aria-hidden="true">‹</span></button>
                <label><span>Operational day</span><input type="date" value="2026-09-29"></label>
                <button aria-label="Next day" class="secondary-button" type="button"><span aria-hidden="true">›</span></button>
              </div>
              <div class="workforce-activity-day-presets">
                <button class="secondary-button" type="button">Yesterday</button>
                <button class="secondary-button" type="button">Today</button>
              </div>
              <span class="workforce-activity-time-zone-note"><span aria-hidden="true">▣</span>Each record uses its assigned time zone</span>
            </div>
          </section>

          <section class="operations-panel workforce-activity-view-panel">
            <div class="workforce-activity-tabs" role="tablist" aria-label="Workforce activity view">
              <button aria-selected="true" class="workforce-activity-tab workforce-activity-tab--active" role="tab" type="button">Who Worked</button>
              <button aria-selected="false" class="workforce-activity-tab" role="tab" type="button">Schedule Comparison</button>
            </div>
            <p>People with a recorded or confirmed work occurrence.</p>
          </section>

          <section class="operations-panel reports-workspace-controls workforce-activity-controls" aria-label="Workforce activity filters">
            <label class="reports-search workforce-activity-search"><span>Search</span><span class="reports-search-input"><span aria-hidden="true">⌕</span><input placeholder="Employee, event, client, site, or post" type="search"></span></label>
            <div class="workforce-activity-filter-grid">
              <label><span>Employee</span><select><option>All employees</option><option selected>Jordan Montgomery · SYG-1000</option></select></label>
              <label><span>Location or event</span><select><option>All locations and events</option><optgroup label="Sites"><option>Downtown Campus — North Administration Entrance</option></optgroup></select></label>
              <label><span>Outcome</span><select><option>All outcomes</option><option>Worked as scheduled (31)</option><option>Salary work confirmed (4)</option></select></label>
              <label><span>Organize by</span><select><option>Location</option><option>Employee</option><option>Day</option></select></label>
            </div>
            <div class="workforce-activity-filter-actions"><p class="workforce-activity-selected-employee" role="status">Showing work for <strong>Jordan Montgomery</strong></p><button class="secondary-button" type="button">Clear filters</button></div>
          </section>

          <section class="operations-metrics workforce-activity-metrics" aria-label="Workforce activity summary">
            <article><span>Actual workers</span><strong>38</strong><small>Recorded or confirmed</small></article>
            <article><span>Scheduled assignments</span><strong>42</strong><small>336 hr planned</small></article>
            <article><span>Worked time</span><strong>287 hr 30 min</strong><small>Hourly recorded time only</small></article>
            <article><span>Salary confirmations</span><strong>4</strong><small>No hours inferred</small></article>
            <article class="import-metric--attention"><span>Coverage changes</span><strong>3</strong><small>1 replacement · 1 call-off · 1 open</small></article>
            <article class="import-metric--attention"><span>Needs review</span><strong>2</strong><small>Time or coverage follow-up</small></article>
          </section>

          <section class="operations-panel reports-results workforce-activity-results" aria-busy="false">
            <div class="reports-section-heading workforce-activity-results-heading">
              <div><p class="eyebrow">09/29/2026</p><h2>38 records</h2><p>Times use each row's recorded time zone. Salary confirmations never create worked hours.</p></div>
              <div class="workforce-activity-export-actions" aria-label="Workforce activity exports">
                <button class="primary-action" type="button"><span aria-hidden="true">↓</span>Export Excel</button>
                <button class="secondary-button" type="button"><span aria-hidden="true">↓</span>Export PDF</button>
              </div>
            </div>

            <div class="workforce-activity-groups">
              <section class="workforce-activity-group" aria-label="Downtown Campus — North Administration Entrance">
                <div class="workforce-activity-group__heading"><div><span aria-hidden="true">●</span><h3>Downtown Campus — North Administration Entrance</h3></div><span>2 records on this page</span></div>
                <div class="workforce-activity-list">
                  <article class="workforce-activity-row workforce-activity-row--worked_as_scheduled">
                    <div class="workforce-activity-row__identity"><span class="workforce-outcome workforce-outcome--worked_as_scheduled">Worked as scheduled</span><strong>Jordan Montgomery-Sutherland</strong><small>SYG-1000</small></div>
                    <div class="workforce-activity-row__location"><span>Location</span><strong>Downtown Campus</strong><small>North Administration Entrance · Overnight Security Post</small></div>
                    <div class="workforce-activity-row__time"><span><span aria-hidden="true">▣</span>Scheduled</span><strong>8:00 PM (20:00) – 4:00 AM (04:00)</strong><small>8 hr</small></div>
                    <div class="workforce-activity-row__time"><span><span aria-hidden="true">◷</span>Actual</span><strong>7:58 PM (19:58) – 4:05 AM (04:05)</strong><small>7 hr 37 min</small></div>
                    <div class="workforce-activity-row__action"><small>America/Denver</small><button class="secondary-button" type="button">View details</button></div>
                  </article>
                  <article class="workforce-activity-row workforce-activity-row--replacement_worked">
                    <div class="workforce-activity-row__identity"><span class="workforce-outcome workforce-outcome--replacement_worked">Replacement worked</span><strong>Alexandra Hernandez</strong><small>SYG-1042</small></div>
                    <div class="workforce-activity-row__location"><span>Location</span><strong>Downtown Campus</strong><small>North Administration Entrance · Special coverage event</small></div>
                    <div class="workforce-activity-row__time"><span><span aria-hidden="true">▣</span>Scheduled</span><strong>6:00 AM (06:00) – 2:00 PM (14:00)</strong><small>8 hr</small></div>
                    <div class="workforce-activity-row__time"><span><span aria-hidden="true">◷</span>Actual</span><strong>5:55 AM (05:55) – 2:04 PM (14:04)</strong><small>7 hr 39 min</small></div>
                    <div class="workforce-activity-row__action"><small>America/Denver</small><button class="secondary-button" type="button">View details</button></div>
                  </article>
                </div>
              </section>

              <section class="workforce-activity-group" aria-label="Regional Operations Center">
                <div class="workforce-activity-group__heading"><div><span aria-hidden="true">●</span><h3>Regional Operations Center</h3></div><span>1 record on this page</span></div>
                <div class="workforce-activity-list">
                  <article class="workforce-activity-row workforce-activity-row--salary_worked_confirmed">
                    <div class="workforce-activity-row__identity"><span class="workforce-outcome workforce-outcome--salary_worked_confirmed">Salary work confirmed</span><strong>Morgan Operations Manager</strong><small>SYG-2001</small></div>
                    <div class="workforce-activity-row__location"><span>Location</span><strong>Regional Operations Center</strong><small>Command desk · Operations administration</small></div>
                    <div class="workforce-activity-row__time"><span><span aria-hidden="true">▣</span>Scheduled</span><strong>8:00 AM (08:00) – 5:00 PM (17:00)</strong><small>9 hr</small></div>
                    <div class="workforce-activity-row__time"><span><span aria-hidden="true">◷</span>Actual</span><strong>Work confirmed</strong><small>Confirmed — hours not calculated</small></div>
                    <div class="workforce-activity-row__action"><small>America/Denver</small><button class="secondary-button" type="button">View details</button></div>
                  </article>
                </div>
              </section>
            </div>

            <nav class="reports-pagination workforce-activity-pagination" aria-label="Workforce activity pages">
              <label><span>Rows</span><select><option>10</option><option selected>25</option><option>50</option></select></label>
              <span>Page 1 of 2</span>
              <button class="secondary-button" disabled type="button">Previous</button>
              <button class="secondary-button" type="button">Next</button>
            </nav>
          </section>
        </div>
      </main>`
  })
}

for (const viewport of viewportCases) {
  test(`workforce activity report stays contained and usable at ${viewport.label}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await installWorkforceActivityFixture(page)

    const overflow = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      offenders: Array.from(document.querySelectorAll<HTMLElement>('.workforce-activity-workspace *')).flatMap((element) => {
        const box = element.getBoundingClientRect()
        return box.left < -1 || box.right > document.documentElement.clientWidth + 1
          ? [{ className: element.className, left: Math.round(box.left), right: Math.round(box.right), tagName: element.tagName }]
          : []
      }),
      scrollWidth: document.documentElement.scrollWidth,
    }))
    expect(overflow.scrollWidth, JSON.stringify(overflow.offenders)).toBeLessThanOrEqual(overflow.clientWidth + 1)
    expect(overflow.offenders).toEqual([])

    for (const control of await page.locator('.workforce-activity-scope__button, .workforce-activity-tab').all()) {
      const box = await control.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.height).toBeGreaterThanOrEqual(40)
    }
    for (const control of await page.locator('.workforce-activity-workspace input, .workforce-activity-workspace select, .workforce-activity-workspace .primary-action, .workforce-activity-workspace .secondary-button').all()) {
      const box = await control.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.height).toBeGreaterThanOrEqual(44)
    }

    const exports = page.getByLabel('Workforce activity exports')
    const pagination = page.getByRole('navigation', { name: 'Workforce activity pages' })
    await expect(exports.getByRole('button', { name: 'Export Excel' })).toBeVisible()
    await expect(exports.getByRole('button', { name: 'Export PDF' })).toBeVisible()
    await expect(pagination).toBeVisible()
    await expect(pagination.getByText('Page 1 of 2')).toBeVisible()
    await expect(pagination.getByRole('button', { name: 'Next' })).toBeVisible()
    await expect(page.getByRole('status')).toContainText('Showing work for Jordan Montgomery')

    const horizontalBounds = await Promise.all([exports, pagination].map(async (locator) => {
      await locator.scrollIntoViewIfNeeded()
      return locator.boundingBox()
    }))
    for (const box of horizontalBounds) {
      expect(box).not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1)
    }

    const accessibility = await new AxeBuilder({ page }).analyze()
    expect(accessibility.violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`workforce-activity-${viewport.width}.png`), fullPage: true })
  })
}
