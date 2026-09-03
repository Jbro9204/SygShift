import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const widths = [1920, 1440, 1280, 1024, 768, 390, 320] as const

async function installHeaderFixture(page: import('@playwright/test').Page, collapsed: boolean) {
  await page.locator('#root').evaluate((root, sidebarCollapsed) => {
    const clocks = [
      ['Eastern', 'EDT'],
      ['Central', 'CDT'],
      ['Mountain', 'MDT'],
      ['Pacific', 'PDT'],
    ].map(([name, abbreviation]) => `
      <article aria-label="${name} time" class="operational-clock${name === 'Mountain' ? ' operational-clock--default' : ''}">
        <svg aria-hidden="true" class="operational-clock__face" viewBox="0 0 64 64">
          <circle class="operational-clock__dial" cx="32" cy="32" r="29"></circle>
          <line class="operational-clock__marker" x1="32" x2="32" y1="6" y2="11"></line>
          <line class="operational-clock__hand operational-clock__hand--hour" x1="32" x2="32" y1="32" y2="18"></line>
          <line class="operational-clock__hand operational-clock__hand--minute" x1="32" x2="32" y1="34" y2="12"></line>
          <line class="operational-clock__hand operational-clock__hand--second" x1="32" x2="32" y1="36" y2="10"></line>
          <circle class="operational-clock__pin" cx="32" cy="32" r="2.5"></circle>
        </svg>
        <span class="operational-clock__details">
          <strong class="operational-clock__digital">11:59 PM (23:59)</strong>
          <span class="operational-clock__zone">${name} · ${abbreviation}</span>
          ${name === 'Mountain' ? '<em>System time</em>' : ''}
        </span>
      </article>`).join('')

    root.innerHTML = `
      <div class="app-shell${sidebarCollapsed ? ' app-shell--sidebar-collapsed' : ''}">
        <button class="mobile-menu-button" type="button" aria-label="Open navigation">☰</button>
        <aside class="sidebar${sidebarCollapsed ? ' sidebar--collapsed' : ''}"><div class="sidebar-brand"><img alt="SygShift" src="/brand/sygshift-logo.png" /></div></aside>
        <div class="workspace">
          <header class="topbar">
            <div class="topbar-date"><span>Monday, 09/01/2026</span></div>
            <section aria-label="United States operational time zones" class="operational-time-zone-strip"><div class="operational-time-zone-grid">${clocks}</div></section>
            <div class="user-menu">
              <div aria-label="Appearance" class="theme-switcher" role="group">
                <button aria-label="Use light mode" aria-pressed="true" class="theme-switcher__button" type="button"><span>☀</span></button>
                <button aria-label="Use dark mode" aria-pressed="false" class="theme-switcher__button" type="button"><span>☾</span></button>
              </div>
              <span aria-hidden="true" class="user-menu__divider"></span>
              <a aria-label="Open My Account for Jordan Brown" class="user-profile-control" href="#account">
                <span class="user-menu__avatar"><span aria-hidden="true">JB</span></span>
                <span class="user-profile-control__copy"><strong>Jordan Brown</strong><span>Admin · @jbrown</span></span>
              </a>
              <button aria-label="Sign Out" class="user-menu__icon-button" type="button"><span>↪</span></button>
            </div>
          </header>
          <section aria-label="Workspace alerts" class="workspace-alert-strip workspace-alert-strip--urgent">
            <div class="workspace-alert-strip__icon">!</div>
            <div class="workspace-alert-strip__copy"><strong>Operational alert</strong><div class="workspace-alert-strip__ticker"><span>This alert remains fully readable beneath the clocks and wraps cleanly when space is limited.</span></div></div>
            <div class="workspace-alert-strip__position">2/2</div>
            <a class="workspace-alert-strip__action" href="#review">Review alert</a>
          </section>
          <main id="main-content"><div class="page"><h1>Workspace content</h1></div></main>
        </div>
      </div>`
  }, collapsed)
}

for (const width of widths) {
  test(`global header stays contained and ordered at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width <= 768 ? 900 : 1000 })
    await page.goto('/')
    await installHeaderFixture(page, false)

    const clocks = page.locator('.operational-clock')
    await expect(clocks).toHaveCount(4)
    for (const clock of await clocks.all()) await expect(clock).toBeVisible()

    const gridColumns = await page.locator('.operational-time-zone-grid').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)
    expect(gridColumns).toBe(width <= 900 ? 2 : 4)

    const clockBottom = await page.locator('.operational-time-zone-strip').evaluate((element) => element.getBoundingClientRect().bottom)
    const alertTop = await page.locator('.workspace-alert-strip').evaluate((element) => element.getBoundingClientRect().top)
    const alertBottom = await page.locator('.workspace-alert-strip').evaluate((element) => element.getBoundingClientRect().bottom)
    const contentTop = await page.locator('#main-content').evaluate((element) => element.getBoundingClientRect().top)
    expect(alertTop - clockBottom).toBeGreaterThanOrEqual(width <= 680 ? 12 : 14)
    expect(contentTop).toBeGreaterThanOrEqual(alertBottom)

    const clippedDigitalTimes = await page.locator('.operational-clock__digital').evaluateAll((elements) => elements.filter((element) => element.scrollWidth > element.clientWidth + 1).length)
    expect(clippedDigitalTimes).toBe(0)
    const alertCopyClipped = await page.locator('.workspace-alert-strip__ticker').evaluate((element) => element.scrollWidth > element.clientWidth + 1)
    expect(alertCopyClipped).toBe(false)
    const viewportWidth = page.viewportSize()!.width
    const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(documentWidth).toBeLessThanOrEqual(viewportWidth)
    await expect(page.getByRole('button', { name: 'Use light mode' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Use dark mode' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open My Account for Jordan Brown' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign Out' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Review alert' })).toBeVisible()

    await page.screenshot({ path: testInfo.outputPath(`global-header-${width}.png`), fullPage: true })
  })
}

test('1024px collapsed sidebar preserves the four-clock desktop row', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1024, height: 1000 })
  await page.goto('/')
  await installHeaderFixture(page, true)
  const gridColumns = await page.locator('.operational-time-zone-grid').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)
  expect(gridColumns).toBe(4)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024)
  await page.screenshot({ path: testInfo.outputPath('global-header-1024-collapsed.png'), fullPage: true })
})

test('reduced motion removes the second hand without hiding clock information', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1024, height: 900 })
  await page.goto('/')
  await installHeaderFixture(page, false)
  await expect(page.locator('.operational-clock__hand--second').first()).toHaveCSS('visibility', 'hidden')
  await expect(page.locator('.operational-clock__digital').first()).toBeVisible()
})

test('the integrated global header has no detectable accessibility violations', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 })
  await page.goto('/')
  await installHeaderFixture(page, false)
  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])
})

test('light and dark selections expose state without relying on color', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')
  await installHeaderFixture(page, false)

  const light = page.getByRole('button', { name: 'Use light mode' })
  const dark = page.getByRole('button', { name: 'Use dark mode' })
  await expect(light).toHaveAttribute('aria-pressed', 'true')
  await expect(dark).toHaveAttribute('aria-pressed', 'false')

  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
    document.documentElement.style.colorScheme = 'dark'
  })
  const canvasColor = await page.locator('html').evaluate((element) => getComputedStyle(element).backgroundColor)
  expect(canvasColor).toBe('rgb(13, 16, 19)')

  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('global-header-dark.png'), fullPage: true })
})
