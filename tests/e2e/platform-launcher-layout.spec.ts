import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

type SidebarFixtureOptions = {
  collapsed?: boolean
  mobileOpen?: boolean
}

async function installSidebarFixture(page: Page, options: SidebarFixtureOptions = {}) {
  await page.locator('#root').evaluate((root, fixtureOptions) => {
    document.documentElement.dataset.theme = 'dark'
    const fixtureRoot = root.cloneNode(false) as HTMLElement
    root.replaceWith(fixtureRoot)
    const navigation = Array.from({ length: 18 }, (_, index) => `
      <a class="navigation-link" href="/item-${index}">
        <span aria-hidden="true">●</span><span>Navigation item ${index + 1}</span>
      </a>`).join('')
    fixtureRoot.innerHTML = `
      <div class="app-shell${fixtureOptions.collapsed ? ' app-shell--sidebar-collapsed' : ''}">
        <aside class="sidebar${fixtureOptions.collapsed ? ' sidebar--collapsed' : ''}${fixtureOptions.mobileOpen ? ' sidebar--open' : ''}">
          <div class="sidebar-brand"><img alt="SygShift" src="/brand/sygshift-logo.png" /></div>
          <nav aria-label="Primary navigation" class="sidebar-navigation">${navigation}</nav>
          <div class="sidebar-utilities">
            <div class="platform-launcher-shell">
              <button aria-label="Open Sygilant main platform" class="platform-launcher platform-launcher--sygilant" title="Sygilant — Main Platform" type="button">
                <span aria-hidden="true" class="platform-launcher__emblem"><img alt="" src="/branding/sygilant-horizontal-transparent.png" /></span>
                <span aria-hidden="true" class="platform-launcher__brand"><img alt="" src="/branding/sygilant-horizontal-transparent.png" /><small>MAIN PLATFORM</small></span>
              </button>
            </div>
            <a aria-label="Open SygSphere messages, 3 unread conversations" class="sphere-launcher" href="#sygsphere" title="SygSphere — 3 unread conversations">
              <img alt="" class="sphere-launcher__emblem" src="/branding/sygsphere-emblem.png" />
              <span class="sphere-launcher__brand"><img alt="SygSphere" src="/branding/sygsphere-logo.png" /><small>MESSAGES</small></span>
              <span class="sphere-badge">3</span>
            </a>
            <button class="support-help-button" type="button"><span aria-hidden="true">?</span><span>Need Help?</span></button>
            <div class="system-status-indicator"><span class="system-status-indicator__dot"></span><span>Online</span></div>
          </div>
        </aside>
        <main class="workspace" id="main-content"><h1>Workspace</h1></main>
      </div>`
  }, options)
}

test('expanded launchers match, stay ordered, and preserve a scrollable navigation region', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/')
  await installSidebarFixture(page)

  const utilities = page.locator('.sidebar-utilities')
  await expect(utilities.locator(':scope > *')).toHaveCount(4)
  await expect(utilities.locator(':scope > *').nth(0)).toHaveClass(/platform-launcher-shell/)
  await expect(utilities.locator(':scope > *').nth(1)).toHaveClass(/sphere-launcher/)
  await expect(utilities.locator(':scope > *').nth(2)).toHaveClass(/support-help-button/)
  await expect(utilities.locator(':scope > *').nth(3)).toHaveClass(/system-status-indicator/)

  const sygilant = page.getByRole('button', { name: 'Open Sygilant main platform' })
  const sphere = page.getByRole('link', { name: /SygSphere messages/ })
  const [sygilantBox, sphereBox] = await Promise.all([sygilant.boundingBox(), sphere.boundingBox()])
  expect(sygilantBox).not.toBeNull()
  expect(sphereBox).not.toBeNull()
  expect(Math.abs(sygilantBox!.width - sphereBox!.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(sygilantBox!.height - sphereBox!.height)).toBeLessThanOrEqual(1)
  expect(sygilantBox!.height).toBeGreaterThanOrEqual(63)

  const layout = await page.locator('.sidebar').evaluate((sidebar) => {
    const navigation = sidebar.querySelector('.sidebar-navigation') as HTMLElement
    const utility = sidebar.querySelector('.sidebar-utilities') as HTMLElement
    const sidebarBox = sidebar.getBoundingClientRect()
    const navigationBox = navigation.getBoundingClientRect()
    const utilityBox = utility.getBoundingClientRect()
    return {
      navigationBottom: navigationBox.bottom,
      navigationScrollable: navigation.scrollHeight > navigation.clientHeight,
      sidebarBottom: sidebarBox.bottom,
      utilityBottom: utilityBox.bottom,
      utilityTop: utilityBox.top,
    }
  })
  expect(layout.navigationBottom).toBeLessThanOrEqual(layout.utilityTop + 1)
  expect(layout.utilityBottom).toBeLessThanOrEqual(layout.sidebarBottom + 1)
  expect(layout.navigationScrollable).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280)

  await sygilant.focus()
  await expect(sygilant).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(sphere).toBeFocused()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('platform-launchers-expanded.png'), fullPage: true })
})

test('collapsed launchers become matching icon controls with exact tooltips', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1024, height: 720 })
  await page.goto('/')
  await installSidebarFixture(page, { collapsed: true })

  const sygilant = page.getByRole('button', { name: 'Open Sygilant main platform' })
  const sphere = page.getByRole('link', { name: /SygSphere messages/ })
  await expect(sygilant).toHaveAttribute('title', 'Sygilant — Main Platform')
  await expect(sphere).toHaveAttribute('title', 'SygSphere — 3 unread conversations')
  await expect(page.locator('.platform-launcher__brand')).toBeHidden()
  await expect(page.locator('.sphere-launcher__brand')).toBeHidden()
  await expect(page.locator('.platform-launcher__emblem')).toBeVisible()
  await expect(page.locator('.sphere-launcher__emblem')).toBeVisible()
  const [sygilantBox, sphereBox] = await Promise.all([sygilant.boundingBox(), sphere.boundingBox()])
  expect(sygilantBox).not.toBeNull()
  expect(sphereBox).not.toBeNull()
  expect(Math.abs(sygilantBox!.width - sphereBox!.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(sygilantBox!.height - sphereBox!.height)).toBeLessThanOrEqual(1)
  expect(sygilantBox!.width).toBeGreaterThanOrEqual(48)
  await page.screenshot({ path: testInfo.outputPath('platform-launchers-collapsed.png'), fullPage: true })
})

for (const viewport of [
  { label: '125-percent', width: 1024, height: 720 },
  { label: '150-percent', width: 854, height: 600 },
  { label: '200-percent', width: 640, height: 450 },
]) {
  test(`launcher footer remains reachable at ${viewport.label} effective viewport`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto('/')
    await installSidebarFixture(page, { mobileOpen: viewport.width <= 900 })

    const sidebar = page.locator('.sidebar')
    await expect(sidebar).toBeVisible()
    const bounds = await sidebar.evaluate((element) => {
      const box = element.getBoundingClientRect()
      const utility = element.querySelector('.sidebar-utilities')!.getBoundingClientRect()
      return { sidebarBottom: box.bottom, utilityBottom: utility.bottom, utilityTop: utility.top }
    })
    expect(bounds.utilityBottom).toBeLessThanOrEqual(bounds.sidebarBottom + 1)
    expect(bounds.utilityTop).toBeGreaterThanOrEqual(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width)
  })
}
