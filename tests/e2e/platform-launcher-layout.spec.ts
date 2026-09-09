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
            <div class="sygtasks-launcher-shell">
              <a aria-describedby="sygtasks-launcher-tooltip" aria-label="Open SygTasks work management" class="sygtasks-launcher" href="/tasks">
                <span aria-hidden="true" class="sygtasks-launcher__emblem"><img alt="" src="/branding/sygtasks-emblem.png" /></span>
                <span aria-hidden="true" class="sygtasks-launcher__brand"><img alt="" src="/branding/sygtasks-logo.png" /><small>WORK MANAGEMENT</small></span>
                <span class="sygtasks-launcher__tooltip" id="sygtasks-launcher-tooltip" role="tooltip">SygTasks · Work Management</span>
              </a>
            </div>
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
            <button class="support-help-button" title="Need Help?" type="button"><span aria-hidden="true">?</span><span>Need Help?</span></button>
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
  await expect(utilities.locator(':scope > *')).toHaveCount(5)
  await expect(utilities.locator(':scope > *').nth(0)).toHaveClass(/sygtasks-launcher-shell/)
  await expect(utilities.locator(':scope > *').nth(1)).toHaveClass(/platform-launcher-shell/)
  await expect(utilities.locator(':scope > *').nth(2)).toHaveClass(/sphere-launcher/)
  await expect(utilities.locator(':scope > *').nth(3)).toHaveClass(/support-help-button/)
  await expect(utilities.locator(':scope > *').nth(4)).toHaveClass(/system-status-indicator/)

  const tasks = page.getByRole('link', { name: 'Open SygTasks work management' })
  const sygilant = page.getByRole('button', { name: 'Open Sygilant main platform' })
  const sphere = page.getByRole('link', { name: /SygSphere messages/ })
  const support = page.getByRole('button', { name: 'Need Help?' })
  const status = page.locator('.system-status-indicator')
  await expect(tasks).toHaveAttribute('href', '/tasks')
  await expect(support).toBeVisible()
  await expect(status).toBeVisible()
  await expect(status).toContainText('Online')
  const [tasksBox, sygilantBox, sphereBox] = await Promise.all([
    tasks.boundingBox(),
    sygilant.boundingBox(),
    sphere.boundingBox(),
  ])
  expect(tasksBox).not.toBeNull()
  expect(sygilantBox).not.toBeNull()
  expect(sphereBox).not.toBeNull()
  expect(Math.abs(tasksBox!.width - sygilantBox!.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(tasksBox!.height - sygilantBox!.height)).toBeLessThanOrEqual(1)
  expect(Math.abs(sygilantBox!.width - sphereBox!.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(sygilantBox!.height - sphereBox!.height)).toBeLessThanOrEqual(1)
  expect(tasksBox!.y + tasksBox!.height).toBeLessThanOrEqual(sygilantBox!.y)
  expect(sygilantBox!.y + sygilantBox!.height).toBeLessThanOrEqual(sphereBox!.y)
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

  await tasks.focus()
  await expect(tasks).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(sygilant).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(sphere).toBeFocused()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('platform-launchers-expanded.png'), fullPage: true })

  await page.route('**/tasks', (route) => route.fulfill({
    body: '<!doctype html><title>SygTasks route</title><main>SygTasks route</main>',
    contentType: 'text/html',
    status: 200,
  }))
  await tasks.click()
  await expect(page).toHaveURL(/\/tasks$/)
})

test('collapsed launchers become matching icon controls with exact tooltips', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1024, height: 720 })
  await page.goto('/')
  await installSidebarFixture(page, { collapsed: true })

  const tasks = page.getByRole('link', { name: 'Open SygTasks work management' })
  const sygilant = page.getByRole('button', { name: 'Open Sygilant main platform' })
  const sphere = page.getByRole('link', { name: /SygSphere messages/ })
  const support = page.getByRole('button', { name: 'Need Help?' })
  const status = page.locator('.system-status-indicator')
  const tasksTooltip = page.locator('#sygtasks-launcher-tooltip')
  await expect(tasks).toHaveAttribute('aria-describedby', 'sygtasks-launcher-tooltip')
  await expect(tasksTooltip).toHaveText('SygTasks · Work Management')
  await expect(sygilant).toHaveAttribute('title', 'Sygilant — Main Platform')
  await expect(sphere).toHaveAttribute('title', 'SygSphere — 3 unread conversations')
  await expect(page.locator('.sygtasks-launcher__brand')).toBeHidden()
  await expect(page.locator('.platform-launcher__brand')).toBeHidden()
  await expect(page.locator('.sphere-launcher__brand')).toBeHidden()
  await expect(page.locator('.sygtasks-launcher__emblem')).toBeVisible()
  await expect(page.locator('.platform-launcher__emblem')).toBeVisible()
  await expect(page.locator('.sphere-launcher__emblem')).toBeVisible()
  await expect(support).toBeVisible()
  await expect(status).toBeVisible()
  const [tasksBox, sygilantBox, sphereBox] = await Promise.all([
    tasks.boundingBox(),
    sygilant.boundingBox(),
    sphere.boundingBox(),
  ])
  expect(tasksBox).not.toBeNull()
  expect(sygilantBox).not.toBeNull()
  expect(sphereBox).not.toBeNull()
  expect(Math.abs(tasksBox!.width - sygilantBox!.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(tasksBox!.height - sygilantBox!.height)).toBeLessThanOrEqual(1)
  expect(Math.abs(sygilantBox!.width - sphereBox!.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(sygilantBox!.height - sphereBox!.height)).toBeLessThanOrEqual(1)
  expect(sygilantBox!.width).toBeGreaterThanOrEqual(48)
  await expect(tasksTooltip).toBeHidden()
  await tasks.focus()
  await expect(tasksTooltip).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('platform-launchers-collapsed.png'), fullPage: true })
})

for (const viewport of [
  { label: 'mobile-phone', width: 390, height: 844 },
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
    await expect(page.getByRole('link', { name: 'Open SygTasks work management' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open Sygilant main platform' })).toBeVisible()
    await expect(page.getByRole('link', { name: /SygSphere messages/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Need Help?' })).toBeVisible()
    await expect(page.locator('.system-status-indicator')).toBeVisible()
    const bounds = await sidebar.evaluate((element) => {
      const box = element.getBoundingClientRect()
      const navigation = element.querySelector('.sidebar-navigation')!.getBoundingClientRect()
      const utility = element.querySelector('.sidebar-utilities')!.getBoundingClientRect()
      return {
        navigationBottom: navigation.bottom,
        sidebarBottom: box.bottom,
        sidebarClientHeight: element.clientHeight,
        sidebarScrollHeight: element.scrollHeight,
        utilityBottom: utility.bottom,
        utilityTop: utility.top,
      }
    })
    expect(bounds.navigationBottom).toBeLessThanOrEqual(bounds.utilityTop + 1)
    expect(bounds.utilityBottom).toBeLessThanOrEqual(bounds.sidebarBottom + 1)
    expect(bounds.utilityTop).toBeGreaterThanOrEqual(0)
    expect(bounds.sidebarScrollHeight).toBeLessThanOrEqual(bounds.sidebarClientHeight + 1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width)
  })
}
