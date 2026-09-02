import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

async function installPatrolFixture(page: import('@playwright/test').Page, theme: 'light' | 'dark') {
  await page.locator('#root').evaluate((root, selectedTheme) => {
    document.documentElement.dataset.theme = selectedTheme
    document.documentElement.style.colorScheme = selectedTheme
    root.innerHTML = `
      <main style="max-width:1372px;margin:32px auto;padding:0 20px">
        <div class="page page--patrol patrol-workspace">
          <section class="page-intro patrol-intro">
            <div><p class="eyebrow">Operations</p><h1>Patrol Command Center</h1><p>Complete assigned patrols, manage versioned routes, and review evidence from one workspace.</p></div>
            <button class="primary-action" type="button">Build patrol route</button>
          </section>
          <section class="patrol-metrics" aria-label="Patrol status">
            <article><div><span>Active patrols</span><strong>4</strong><small>Connected to published shifts</small></div></article>
            <article><div><span>Required hits</span><strong>18</strong><small>Due in the active window</small></div></article>
            <article class="patrol-metric--success"><div><span>Completed</span><strong>12</strong><small>Submitted with required notes</small></div></article>
            <article><div><span>Missed</span><strong>0</strong><small>Available for makeup review</small></div></article>
          </section>
          <nav class="patrol-tabs" aria-label="Patrol workspace"><button class="is-active" type="button">Overview</button><button type="button">My Patrol</button><button type="button">Operations</button><button type="button">Routes &amp; Requirements</button></nav>
          <section class="workforce-toolbar patrol-toolbar" aria-label="Patrol list controls"><label class="search-field"><span>Search</span><input placeholder="Route, employee, site, or status" /></label><label class="patrol-row-count"><span>Rows</span><select><option>5</option><option>10</option><option>20</option></select></label></section>
          <section class="patrol-assignment-list">
            <article class="operations-panel patrol-assignment-card">
              <header><div><p class="eyebrow">Unarmed patrol</p><h2>MG Properties Patrol</h2><span>09/02/2026, 8:00 PM – 09/03/2026, 4:00 AM</span></div><div class="patrol-progress"><strong>67%</strong><span>complete</span></div></header>
              <div class="patrol-obligation-list">
                <div class="patrol-obligation-row"><div><strong>Stone Cliff Apts</strong><span>Night patrol · Hit 1</span><small>Due 09/02/2026, 11:00 PM</small></div><span class="patrol-status patrol-status--due">Due</span><button class="primary-action primary-action--compact" type="button">Complete hit</button></div>
                <div class="patrol-obligation-row"><div><strong>Malbec</strong><span>Night patrol · Hit 1</span><small>Completed and recorded</small></div><span class="patrol-status patrol-status--completed">Completed</span></div>
              </div>
              <footer><button class="secondary-button" type="button">Record extra hit</button></footer>
            </article>
          </section>
        </div>
      </main>`
  }, theme)
}

for (const theme of ['light', 'dark'] as const) {
  test(`Patrol workspace is compact, contained, and readable in ${theme} mode`, async ({ page }, testInfo) => {
    await page.goto('/')
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim().length > 0)
    await installPatrolFixture(page, theme)

    const viewport = page.viewportSize()
    expect(viewport).not.toBeNull()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)

    for (const region of [page.getByRole('region', { name: 'Patrol status' }), page.getByRole('navigation', { name: 'Patrol workspace' }), page.getByRole('region', { name: 'Patrol list controls' })]) {
      expect(await region.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    }

    for (const control of await page.locator('button, input, select').all()) {
      const box = await control.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.height).toBeGreaterThanOrEqual(32)
    }

    const assignment = page.locator('.patrol-assignment-card')
    const assignmentBox = await assignment.boundingBox()
    expect(assignmentBox).not.toBeNull()
    expect(assignmentBox!.x).toBeGreaterThanOrEqual(4)
    expect(assignmentBox!.x + assignmentBox!.width).toBeLessThanOrEqual(viewport!.width - 4)

    const accessibility = await new AxeBuilder({ page }).analyze()
    expect(accessibility.violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`patrol-${theme}.png`), fullPage: true })
  })
}
