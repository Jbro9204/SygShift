import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const widths = [1920, 1440, 1280, 1024, 768, 390, 320] as const

async function installHeaderFixture(page: import('@playwright/test').Page, collapsed: boolean) {
  await page.locator('#root').evaluate((root, sidebarCollapsed) => {
    const fixtureRoot = root.cloneNode(false) as HTMLElement
    root.replaceWith(fixtureRoot)
    fixtureRoot.innerHTML = `
      <div class="app-shell${sidebarCollapsed ? ' app-shell--sidebar-collapsed' : ''}">
        <button class="mobile-menu-button" type="button" aria-label="Open navigation">☰</button>
        <aside class="sidebar${sidebarCollapsed ? ' sidebar--collapsed' : ''}"><div class="sidebar-brand"><img alt="SygShift" src="/brand/sygshift-logo.png" /></div></aside>
        <div class="workspace">
          <header class="topbar">
            <div class="topbar-date"><span>Monday, 09/01/2026</span></div>
            <section aria-label="System time for Central: 11:59 PM (23:59), CDT" class="user-system-time">
              <strong class="user-system-time__time">11:59 PM (23:59)</strong>
              <span class="user-system-time__zone">Central · CDT</span>
              <em>System time</em>
            </section>
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
            <div class="workspace-alert-strip__copy"><strong>Operational alert</strong><div class="workspace-alert-strip__ticker"><span>This alert remains fully readable beneath the system time and wraps cleanly when space is limited.</span></div></div>
            <div class="workspace-alert-strip__position">2/2</div>
            <a class="workspace-alert-strip__action" href="#review">Review alert</a>
          </section>
          <main id="main-content"><div class="page"><h1>Workspace content</h1></div></main>
        </div>
      </div>`
  }, collapsed)
}

for (const width of widths) {
  test(`global header keeps one contained system-time display at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width <= 768 ? 900 : 1000 })
    await page.goto('/')
    await installHeaderFixture(page, false)

    const systemTime = page.locator('.user-system-time')
    await expect(systemTime).toHaveCount(1)
    await expect(systemTime).toBeVisible()
    await expect(page.locator('.operational-clock')).toHaveCount(0)
    await expect(page.locator('.user-system-time__time')).toHaveText('11:59 PM (23:59)')
    await expect(page.locator('.user-system-time__zone')).toHaveText('Central · CDT')
    if (width > 360) await expect(page.getByText('System time', { exact: true })).toBeVisible()

    const headerBottom = await page.locator('.topbar').evaluate((element) => element.getBoundingClientRect().bottom)
    const alertTop = await page.locator('.workspace-alert-strip').evaluate((element) => element.getBoundingClientRect().top)
    const alertBottom = await page.locator('.workspace-alert-strip').evaluate((element) => element.getBoundingClientRect().bottom)
    const contentTop = await page.locator('#main-content').evaluate((element) => element.getBoundingClientRect().top)
    expect(alertTop - headerBottom).toBeGreaterThanOrEqual(width <= 680 ? 12 : 14)
    expect(contentTop).toBeGreaterThanOrEqual(alertBottom)

    const clippedTime = await page.locator('.user-system-time__time').evaluate((element) => element.scrollWidth > element.clientWidth + 1)
    const clippedZone = await page.locator('.user-system-time__zone').evaluate((element) => element.scrollWidth > element.clientWidth + 1)
    expect(clippedTime).toBe(false)
    expect(clippedZone).toBe(false)
    const timeTextSize = await page.locator('.user-system-time__time').evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))
    const zoneTextSize = await page.locator('.user-system-time__zone').evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))
    expect(timeTextSize).toBeGreaterThanOrEqual(width <= 680 ? 13 : 16)
    expect(zoneTextSize).toBeGreaterThanOrEqual(width <= 680 ? 12 : 13)

    const containment = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>('.topbar')!.getBoundingClientRect()
      const time = document.querySelector<HTMLElement>('.user-system-time')!.getBoundingClientRect()
      return { headerLeft: header.left, headerRight: header.right, timeLeft: time.left, timeRight: time.right }
    })
    expect(containment.timeLeft).toBeGreaterThanOrEqual(containment.headerLeft - 1)
    expect(containment.timeRight).toBeLessThanOrEqual(containment.headerRight + 1)

    const alertCopyClipped = await page.locator('.workspace-alert-strip__ticker').evaluate((element) => element.scrollWidth > element.clientWidth + 1)
    expect(alertCopyClipped).toBe(false)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await expect(page.getByRole('button', { name: 'Use light mode' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Use dark mode' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open My Account for Jordan Brown' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign Out' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Review alert' })).toBeVisible()

    await page.screenshot({ path: testInfo.outputPath(`global-header-${width}.png`), fullPage: true })
  })
}

test('1024px collapsed sidebar preserves the single system-time display', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1024, height: 1000 })
  await page.goto('/')
  await installHeaderFixture(page, true)
  await expect(page.locator('.user-system-time')).toHaveCount(1)
  await expect(page.locator('.operational-clock')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024)
  await page.screenshot({ path: testInfo.outputPath('global-header-1024-collapsed.png'), fullPage: true })
})

test('reduced motion keeps the digital system time and has no analog animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1024, height: 900 })
  await page.goto('/')
  await installHeaderFixture(page, false)
  await expect(page.locator('.user-system-time__time')).toBeVisible()
  await expect(page.locator('.operational-clock__hand')).toHaveCount(0)
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
