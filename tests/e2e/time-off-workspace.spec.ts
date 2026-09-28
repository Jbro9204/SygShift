import { expect, test, type Locator, type Page } from '@playwright/test'
import { join } from 'node:path'
import { createServer, type ViteDevServer } from 'vite'

const pendingRequestId = '30000000-0000-4000-8000-000000000001'
const viewports = [
  { label: 'mobile', width: 390, height: 844 },
  { label: 'small phone', width: 320, height: 480 },
] as const

let fixtureServer: ViteDevServer
let fixtureUrl = ''

test.beforeAll(async () => {
  fixtureServer = await createServer({
    configFile: join(process.cwd(), 'tests', 'fixtures', 'time-off-vite.config.ts'),
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  })
  await fixtureServer.listen()
  const origin = fixtureServer.resolvedUrls?.local[0]
  if (!origin) throw new Error('Time Off actual-component fixture did not publish a local URL.')
  fixtureUrl = new URL('/tests/fixtures/time-off-ui.html', origin).toString()
})

test.afterAll(async () => {
  await fixtureServer?.close()
})

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name.includes('mobile-'), 'This suite sets the two required exact mobile viewports in one browser project.')
})

async function openFixture(page: Page, options: { deep?: string; scenario?: string; viewer?: 'employee' | 'manager' } = {}) {
  const url = new URL(fixtureUrl)
  url.searchParams.set('theme', 'dark')
  url.searchParams.set('viewer', options.viewer ?? 'employee')
  if (options.deep) url.searchParams.set('deep', options.deep)
  if (options.scenario) url.searchParams.set('scenario', options.scenario)
  await page.goto(url.toString())
  await expect(page.getByRole('heading', { name: 'Time Off', level: 1 })).toBeVisible()
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - document.body.clientWidth,
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    page: (() => {
      const element = document.querySelector<HTMLElement>('.page--requests')
      return element ? element.scrollWidth - element.clientWidth : Number.POSITIVE_INFINITY
    })(),
  }))
  expect(overflow.document, `Document overflow: ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(1)
  expect(overflow.body, `Body overflow: ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(1)
  expect(overflow.page, `Time Off page overflow: ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(1)
}

async function expectContainedDialog(page: Page, dialog: Locator) {
  await expect(dialog).toBeVisible()
  const bounds = await dialog.boundingBox()
  const viewport = page.viewportSize()
  expect(bounds).not.toBeNull()
  expect(viewport).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.y).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport!.width + 1)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport!.height + 1)
  expect(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
}

for (const viewport of viewports) {
  test(`employee upcoming, history, and withdrawal stay usable at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await openFixture(page)

    const workspaceTabs = page.getByRole('navigation', { name: 'Request workspace' })
    await expect(workspaceTabs).toBeVisible()
    await expect(workspaceTabs.getByRole('button', { name: /Time Off/ })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('heading', { name: 'Upcoming requests' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Past and closed requests' })).toBeAttached()
    await expect(page.getByText('Coverage is confirmed.')).toBeAttached()
    await expect(page.getByText('Withdrawn', { exact: true })).toBeAttached()
    await expectNoHorizontalOverflow(page)

    const withdraw = page.getByRole('button', { name: 'Withdraw request' }).first()
    await withdraw.scrollIntoViewIfNeeded()
    await withdraw.click()
    const dialog = page.getByRole('dialog', { name: 'Withdraw time-off request?' })
    await expectContainedDialog(page, dialog)
    await expect(dialog.getByText('10/12/2099 – 10/14/2099')).toBeVisible()
    await dialog.getByRole('button', { name: 'Keep request' }).click()
    await expect(dialog).toHaveCount(0)
    await expectNoHorizontalOverflow(page)
    await page.screenshot({ path: testInfo.outputPath(`time-off-employee-${viewport.label.replaceAll(' ', '-')}.png`), fullPage: true })
  })

  test(`manager queue, decision history, and self-review suppression stay usable at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await openFixture(page, { viewer: 'manager' })

    await expect(page.getByRole('heading', { name: 'Pending Time Off review' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Decision history' })).toBeAttached()
    await expect(page.getByText(/newest 100 completed team requests/)).toBeVisible()
    await expect(page.getByText(/Your request is waiting for a different authorized reviewer/)).toBeAttached()
    await expect(page.getByRole('button', { name: 'Review request' })).toHaveCount(1)
    await expectNoHorizontalOverflow(page)

    const search = page.getByRole('searchbox', { name: 'Search requests' })
    await search.fill('family appointment')
    await expect(page.getByText('Coverage is confirmed.')).toBeVisible()
    await expect(page.getByText('Medical appointment and recovery time.')).toHaveCount(0)
    await expectNoHorizontalOverflow(page)
    await page.screenshot({ path: testInfo.outputPath(`time-off-manager-${viewport.label.replaceAll(' ', '-')}.png`), fullPage: true })
  })
}

test('an exact manager record deep link opens the matching review at 320x480', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 480 })
  await openFixture(page, { deep: pendingRequestId, viewer: 'manager' })

  const dialog = page.getByRole('dialog', { name: 'Review Time-Off Request' })
  await expectContainedDialog(page, dialog)
  await expect(dialog.getByText('Alex Guard')).toBeVisible()
  await expect(dialog.getByText('Return 10/15/2099')).toBeVisible()
  await expect(dialog.getByText('Front Desk')).toBeAttached()
  await expectNoHorizontalOverflow(page)
})

test('a plain load failure hides technical details and retry restores the workspace', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openFixture(page, { scenario: 'error' })

  await expect(page.getByRole('heading', { name: 'Time Off could not be loaded' })).toBeVisible()
  await expect(page.getByText('Your request records are temporarily unavailable. Nothing was changed. Try again in a moment.')).toBeVisible()
  await expect(page.getByText(/fixture database socket/i)).toHaveCount(0)
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('heading', { name: 'Upcoming requests' })).toBeVisible()
  await expectNoHorizontalOverflow(page)
})
