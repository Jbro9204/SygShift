import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { join } from 'node:path'
import { createServer, type ViteDevServer } from 'vite'

type Theme = 'light' | 'dark'

const viewports = [
  { label: 'desktop', width: 1440, height: 900 },
  { label: 'laptop', width: 1280, height: 720 },
  { label: 'tablet', width: 768, height: 1024 },
  { label: 'mobile', width: 390, height: 844 },
] as const

let fixtureServer: ViteDevServer
let fixtureUrl = ''

test.beforeAll(async () => {
  fixtureServer = await createServer({
    configFile: join(process.cwd(), 'tests', 'fixtures', 'sygtasks-vite.config.ts'),
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  })
  await fixtureServer.listen()
  const origin = fixtureServer.resolvedUrls?.local[0]
  if (!origin) throw new Error('SygTasks visual fixture did not publish a local URL.')
  fixtureUrl = new URL('/tests/fixtures/sygtasks-ui.html', origin).toString()
})

test.afterAll(async () => {
  await fixtureServer?.close()
})

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name.includes('mobile-'), 'The suite defines exact desktop, laptop, tablet, and mobile CSS viewports in one browser project.')
})

async function openFixture(page: Page, theme: Theme, mode: 'my-work' | 'boards' = 'my-work') {
  const url = new URL(fixtureUrl)
  url.searchParams.set('theme', theme)
  if (mode === 'boards') url.searchParams.set('mode', 'boards')
  await page.goto(url.toString())
  await expect(page.getByRole('heading', { name: 'SygTasks', level: 1 })).toBeAttached()
  await expect(page.locator('.sygtasks-header__logo')).toHaveJSProperty('complete', true)
}

async function expectNoGlobalHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - document.body.clientWidth,
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    workspace: (() => {
      const element = document.querySelector<HTMLElement>('.sygtasks-workspace')
      return element ? element.scrollWidth - element.clientWidth : Number.POSITIVE_INFINITY
    })(),
  }))
  expect(overflow.document, `Document overflow: ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(1)
  expect(overflow.body, `Body overflow: ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(1)
  expect(overflow.workspace, `Workspace overflow: ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(1)
}

async function expectControl(locator: Locator, minimumFontSize = 13) {
  await expect(locator).toBeVisible()
  const dimensions = await locator.evaluate((element) => {
    const box = element.getBoundingClientRect()
    return { fontSize: Number.parseFloat(getComputedStyle(element).fontSize), height: box.height, width: box.width }
  })
  expect(dimensions.fontSize).toBeGreaterThanOrEqual(minimumFontSize)
  expect(dimensions.height).toBeGreaterThanOrEqual(44)
  expect(dimensions.width).toBeGreaterThan(0)
}

async function expectContainedDialog(page: Page, name: string | RegExp, role: 'dialog' | 'alertdialog' = 'dialog') {
  const dialog = page.getByRole(role, { name })
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
  return dialog
}

async function expectAxeClean(page: Page, include: string) {
  const result = await new AxeBuilder({ page })
    .include(include)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze()
  expect(result.violations, result.violations.map((violation) => `${violation.id}: ${violation.help}`).join('\n')).toEqual([])
}

for (const theme of ['light', 'dark'] as const) {
  for (const viewport of viewports) {
    test(`SygTasks My Work and Boards remain usable in ${theme} ${viewport.label}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await openFixture(page, theme)

      await expect(page.getByRole('navigation', { name: 'SygTasks workspaces' })).toBeVisible()
      await expect(page.getByRole('button', { name: /My Work/ })).toHaveAttribute('aria-current', 'page')
      await expect(page.getByRole('region', { name: 'My Work summary' }).locator('article')).toHaveCount(4)
      await expect(page.getByText('Due Today', { exact: true })).toBeVisible()
      await expect(page.getByText('Completed This Month', { exact: true })).toBeVisible()
      await expectControl(page.getByRole('textbox', { name: 'Search' }))
      await expectControl(page.locator('.sygtasks-toolbar select').nth(0))
      await expectControl(page.locator('.sygtasks-toolbar select').nth(1))
      await expect(page.getByRole('table')).toBeVisible()
      await expect(page.getByRole('columnheader', { name: 'Board' })).toBeAttached()
      await expect(page.locator('.sygtasks-task-link strong', { hasText: 'Confirm weekend coverage' })).toBeVisible()
      await expectNoGlobalHorizontalOverflow(page)
      await expectAxeClean(page, '.sygtasks-workspace')
      await page.screenshot({ path: testInfo.outputPath(`sygtasks-my-work-${theme}-${viewport.label}.png`), fullPage: true })

      await page.getByRole('button', { name: /Boards/ }).click()
      await expect(page.getByRole('button', { name: /Boards/ })).toHaveAttribute('aria-current', 'page')
      await expect(page.getByRole('navigation', { name: 'Task boards' })).toBeVisible()
      await expect(page.getByRole('button', { name: /Operations Priorities/ })).toHaveAttribute('aria-current', 'page')
      await expect(page.locator('[aria-label="Kanban board"]')).toBeVisible()
      await expect(page.locator('.sygtasks-column')).toHaveCount(7)
      await expect(page.locator('.sygtasks-kanban-shell')).toHaveCSS('overflow-x', 'hidden')
      const kanbanOverflow = await page.locator('.sygtasks-kanban').evaluate((element) => ({
        client: element.clientWidth,
        overflowX: getComputedStyle(element).overflowX,
        scroll: element.scrollWidth,
      }))
      expect(['auto', 'scroll']).toContain(kanbanOverflow.overflowX)
      expect(kanbanOverflow.scroll).toBeGreaterThan(kanbanOverflow.client)
      await expectNoGlobalHorizontalOverflow(page)

      const search = page.getByRole('textbox', { name: 'Search' })
      await search.fill('payroll')
      await expect(page.locator('.sygtasks-card__open strong', { hasText: 'Review payroll exception' })).toBeVisible()
      await expect(page.locator('.sygtasks-card__open strong', { hasText: 'Confirm weekend coverage' })).toHaveCount(0)
      await search.fill('')
      await page.getByRole('button', { name: 'List', exact: true }).click()
      await expect(page.getByRole('button', { name: 'List', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByRole('table')).toBeVisible()
      await page.getByRole('button', { name: 'Board', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Board', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expectAxeClean(page, '.sygtasks-workspace')
      await page.screenshot({ path: testInfo.outputPath(`sygtasks-boards-${theme}-${viewport.label}.png`), fullPage: true })
    })
  }
}

test('SygTasks dialogs validate, contain content, restore focus, and dismiss with Escape', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openFixture(page, 'dark')

  const newBoard = page.getByRole('button', { name: 'New Board' })
  await newBoard.click()
  const boardDialog = await expectContainedDialog(page, 'Create a SygTasks board')
  await expect(page.getByRole('textbox', { name: /Board name/ })).toBeFocused()
  await page.getByRole('button', { name: 'Create Board' }).click()
  await expect(page.getByText('Enter at least two characters for the board name.')).toBeVisible()
  await expectAxeClean(page, 'dialog.sygtasks-dialog')
  await page.screenshot({ path: testInfo.outputPath('sygtasks-create-board-dark-mobile.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await expect(boardDialog).toHaveCount(0)
  await expect(newBoard).toBeFocused()

  await page.getByRole('button', { name: /Boards/ }).click()
  const newTask = page.getByRole('button', { name: 'New Task' })
  await newTask.click()
  const taskDialog = await expectContainedDialog(page, 'Create a task')
  await expect(page.getByRole('textbox', { name: /Task title/ })).toBeFocused()
  await expect(page.getByRole('combobox', { name: /Assignee/ })).toContainText('Elliot Olivarria')
  await expect(page.getByLabel(/Due date and time/)).toBeVisible()
  await expectAxeClean(page, 'dialog.sygtasks-dialog')
  await page.screenshot({ path: testInfo.outputPath('sygtasks-create-task-dark-mobile.png'), fullPage: true })
  await taskDialog.getByRole('button', { name: 'Cancel' }).scrollIntoViewIfNeeded()
  await expect(taskDialog.getByRole('button', { name: 'Cancel' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(taskDialog).toHaveCount(0)
  await expect(newTask).toBeFocused()

  const settingsButton = page.getByRole('button', { name: 'Board Settings' })
  await settingsButton.click()
  const settingsDialog = await expectContainedDialog(page, 'Board Settings')
  await expect(page.getByText('Jordan Brown', { exact: true }).first()).toBeVisible()
  await expect(page.locator('.sygtasks-member-role', { hasText: /editor/i })).toBeVisible()
  await expect(page.locator('.sygtasks-member-role', { hasText: /viewer/i })).toBeVisible()
  await expectAxeClean(page, 'dialog.sygtasks-dialog')
  await page.screenshot({ path: testInfo.outputPath('sygtasks-board-settings-dark-mobile.png'), fullPage: true })

  await page.getByRole('button', { name: 'Archive Board' }).click()
  const confirmDialog = await expectContainedDialog(page, 'Archive this board?', 'alertdialog')
  await expect(confirmDialog).toHaveAttribute('role', 'alertdialog')
  await expect(page.getByText('not permanent deletion', { exact: false })).toBeVisible()
  await expectAxeClean(page, 'dialog.sygtasks-confirm-dialog')
  await page.screenshot({ path: testInfo.outputPath('sygtasks-archive-confirm-dark-mobile.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await expect(confirmDialog).toHaveCount(0)
  await expect(settingsDialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(settingsDialog).toHaveCount(0)
  await expect(settingsButton).toBeFocused()
  await expectNoGlobalHorizontalOverflow(page)
})

test('SygTasks reflows at a 200 percent effective viewport without trapping work off-screen', async ({ page }, testInfo) => {
  // Browser zoom at 200% halves the CSS viewport. A 720 × 450 CSS viewport is
  // the standards-based reflow equivalent of 1440 × 900 at 200% zoom.
  await page.setViewportSize({ width: 720, height: 450 })
  await openFixture(page, 'dark')
  await expect(page.getByRole('button', { name: 'New Board' })).toBeVisible()
  await expect(page.getByText('Completed This Month', { exact: true })).toBeVisible()
  await expect(page.locator('.sygtasks-task-link strong', { hasText: 'Confirm weekend coverage' })).toBeVisible()
  await expectNoGlobalHorizontalOverflow(page)

  await page.getByRole('button', { name: /Boards/ }).click()
  await expect(page.getByRole('button', { name: 'New Task' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Task boards' })).toBeVisible()
  await expectNoGlobalHorizontalOverflow(page)
  await expectAxeClean(page, '.sygtasks-workspace')
  await page.screenshot({ path: testInfo.outputPath('sygtasks-200-percent-dark.png'), fullPage: true })
})
