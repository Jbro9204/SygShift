import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

type SidebarFixtureOptions = {
  collapsed?: boolean
  compact?: boolean
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
      <div class="app-shell${fixtureOptions.collapsed ? ' app-shell--sidebar-collapsed' : ''}${fixtureOptions.compact ? ' app-shell--compact-navigation' : ''}">
        <button aria-expanded="false" aria-label="Open navigation" class="mobile-menu-button" type="button">☰</button>
        <div aria-hidden="true" class="navigation-scrim"></div>
        <aside class="sidebar${fixtureOptions.collapsed ? ' sidebar--collapsed' : ''}${fixtureOptions.mobileOpen ? ' sidebar--open' : ''}">
          <div class="sidebar-brand"><img alt="SygShift" src="/brand/sygshift-logo.png" /></div>
          <nav aria-label="Primary navigation" class="sidebar-navigation">${navigation}</nav>
          <div class="sidebar-utilities">
            <div class="syg-launcher-shell sygtasks-launcher-shell">
              <a aria-describedby="sygtasks-launcher-tooltip" aria-label="Open SygTasks work management" class="syg-launcher syg-launcher--tasks sygtasks-launcher" href="/tasks">
                <span aria-hidden="true" class="syg-launcher__emblem sygtasks-launcher__emblem"><img alt="" src="/branding/sygtasks-emblem.png" /></span>
                <span aria-hidden="true" class="syg-launcher__brand sygtasks-launcher__brand"><img alt="" src="/branding/sygtasks-logo.png" /><small>WORK MANAGEMENT</small></span>
                <span class="sygtasks-launcher__tooltip" id="sygtasks-launcher-tooltip" role="tooltip">SygTasks · Work Management</span>
              </a>
            </div>
            <div class="syg-launcher-shell platform-launcher-shell">
              <button aria-label="Open Sygilant main platform" class="syg-launcher syg-launcher--sygilant platform-launcher platform-launcher--sygilant" title="Sygilant — Main Platform" type="button">
                <span aria-hidden="true" class="syg-launcher__emblem platform-launcher__emblem"><img alt="" src="/branding/sygilant-horizontal-transparent.png" /></span>
                <span aria-hidden="true" class="syg-launcher__brand platform-launcher__brand"><img alt="" src="/branding/sygilant-horizontal-transparent.png" /><small>MAIN PLATFORM</small></span>
              </button>
            </div>
            <a aria-label="Open SygSphere messages, 3 unread conversations" class="syg-launcher syg-launcher--sphere sphere-launcher" href="#sygsphere" title="SygSphere — 3 unread conversations">
              <img alt="" class="syg-launcher__emblem sphere-launcher__emblem" src="/branding/sygsphere-emblem.png" />
              <span aria-hidden="true" class="syg-launcher__brand sphere-launcher__brand"><img alt="" src="/branding/sygsphere-logo.png" /><small>MESSAGES</small></span>
              <span class="syg-launcher__badge sphere-badge">3</span>
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
  await page.locator('.syg-launcher img').evaluateAll(async (images) => {
    await Promise.all(images.map((image) => (image as HTMLImageElement).decode()))
  })

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
  expect(tasksBox!.width).toBeGreaterThanOrEqual(240)
  expect(tasksBox!.y + tasksBox!.height).toBeLessThanOrEqual(sygilantBox!.y)
  expect(sygilantBox!.y + sygilantBox!.height).toBeLessThanOrEqual(sphereBox!.y)
  expect(sygilantBox!.height).toBeGreaterThanOrEqual(63)

  const visualSystem = await Promise.all([tasks, sygilant, sphere].map((launcher) => launcher.evaluate((element) => {
    const style = getComputedStyle(element)
    const elementBox = element.getBoundingClientRect()
    const logo = element.querySelector('.syg-launcher__brand img') as HTMLImageElement
    const logoBox = logo.getBoundingClientRect()
    const subtitle = element.querySelector('small') as HTMLElement
    const subtitleBox = subtitle.getBoundingClientRect()
    return {
      backgroundColor: style.backgroundColor,
      borderRadius: style.borderRadius,
      boxShadow: style.boxShadow,
      height: style.height,
      logoComplete: logo.complete,
      logoHeight: logoBox.height,
      logoNaturalWidth: logo.naturalWidth,
      logoWidth: logoBox.width,
      paddingBlock: `${style.paddingTop} ${style.paddingBottom}`,
      subtitleBottomInset: elementBox.bottom - subtitleBox.bottom,
      subtitleFontSize: getComputedStyle(subtitle).fontSize,
      subtitleLetterSpacing: getComputedStyle(subtitle).letterSpacing,
    }
  })))
  expect(new Set(visualSystem.map((item) => item.height))).toEqual(new Set(['64px']))
  expect(new Set(visualSystem.map((item) => item.borderRadius))).toEqual(new Set(['15px']))
  expect(new Set(visualSystem.map((item) => item.paddingBlock))).toEqual(new Set(['7px 7px']))
  expect(new Set(visualSystem.map((item) => item.backgroundColor)).size).toBe(1)
  expect(new Set(visualSystem.map((item) => item.boxShadow)).size).toBe(1)
  expect(new Set(visualSystem.map((item) => item.subtitleFontSize))).toEqual(new Set(['8px']))
  expect(new Set(visualSystem.map((item) => item.subtitleLetterSpacing)).size).toBe(1)
  expect(Math.max(...visualSystem.map((item) => item.subtitleBottomInset)) - Math.min(...visualSystem.map((item) => item.subtitleBottomInset))).toBeLessThanOrEqual(1)
  expect(visualSystem.every((item) => item.logoComplete && item.logoNaturalWidth > 0)).toBe(true)
  expect(visualSystem.every((item) => item.logoWidth >= 100 && item.logoHeight >= 25)).toBe(true)

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
  await page.locator('.syg-launcher img').evaluateAll(async (images) => {
    await Promise.all(images.map((image) => (image as HTMLImageElement).decode()))
  })

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
  const compactStyles = await Promise.all([tasks, sygilant, sphere].map((launcher) => launcher.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      borderRadius: style.borderRadius,
      height: style.height,
      padding: style.padding,
      width: style.width,
    }
  })))
  expect(new Set(compactStyles.map((item) => item.width))).toEqual(new Set(['48px']))
  expect(new Set(compactStyles.map((item) => item.height))).toEqual(new Set(['48px']))
  expect(new Set(compactStyles.map((item) => item.borderRadius))).toEqual(new Set(['13px']))
  expect(new Set(compactStyles.map((item) => item.padding))).toEqual(new Set(['0px']))
  await expect(tasksTooltip).toBeHidden()
  await tasks.focus()
  await expect(tasksTooltip).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('platform-launchers-collapsed.png'), fullPage: true })
})

for (const viewport of [
  { label: '14-inch-laptop', width: 1366, height: 768 },
  { label: 'scaled-laptop', width: 1280, height: 720 },
  { label: 'compact-laptop', width: 1024, height: 768 },
]) {
  test(`compact shell returns workspace width and a full navigation drawer at ${viewport.label}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    await page.goto('/')
    await installSidebarFixture(page, { compact: true })

    const menu = page.getByRole('button', { name: 'Open navigation' })
    const sidebar = page.locator('.sidebar')
    const workspace = page.locator('.workspace')
    await expect(menu).toBeVisible()
    await expect(sidebar).toBeHidden()
    const closedLayout = await workspace.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return { left: box.left, right: box.right, width: box.width }
    })
    expect(closedLayout.left).toBe(0)
    expect(closedLayout.right).toBe(viewport.width)
    expect(closedLayout.width).toBe(viewport.width)

    await sidebar.evaluate((element) => element.classList.add('sidebar--open'))
    await page.locator('.navigation-scrim').evaluate((element) => element.classList.add('navigation-scrim--visible'))
    await expect(sidebar).toBeVisible()
    await expect.poll(() => sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().left))).toBe(0)
    await expect(page.getByRole('link', { name: 'Open SygTasks work management' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open Sygilant main platform' })).toBeVisible()
    await expect(page.getByRole('link', { name: /SygSphere messages/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Need Help?' })).toBeVisible()
    const drawer = await sidebar.evaluate((element) => {
      const box = element.getBoundingClientRect()
      const navigation = element.querySelector<HTMLElement>('.sidebar-navigation')!
      const utilities = element.querySelector<HTMLElement>('.sidebar-utilities')!
      return {
        bottom: box.bottom,
        left: box.left,
        navigationBottom: navigation.getBoundingClientRect().bottom,
        utilitiesBottom: utilities.getBoundingClientRect().bottom,
        utilitiesTop: utilities.getBoundingClientRect().top,
        width: box.width,
      }
    })
    expect(Math.round(drawer.left)).toBe(0)
    expect(drawer.width).toBeGreaterThanOrEqual(280)
    expect(drawer.navigationBottom).toBeLessThanOrEqual(drawer.utilitiesTop + 1)
    expect(drawer.utilitiesBottom).toBeLessThanOrEqual(drawer.bottom + 1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width)
    await page.screenshot({ path: testInfo.outputPath(`compact-shell-${viewport.label}.png`), fullPage: true })
  })
}

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
