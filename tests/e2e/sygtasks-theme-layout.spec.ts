import AxeBuilder from '@axe-core/playwright'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'

const sygTasksStyles = readFileSync(join(process.cwd(), 'src', 'styles', 'sygtasks.css'), 'utf8')
const sygTasksPageSource = readFileSync(join(process.cwd(), 'src', 'pages', 'SygTasksPage.tsx'), 'utf8')

const scenarios = [
  { height: 900, label: 'desktop', width: 1440 },
  { height: 844, label: 'phone', width: 390 },
] as const

async function installSygTasksFixture(page: Page, theme: 'light' | 'dark') {
  await page.goto('/')
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim().length > 0)
  // SygTasks is route-lazy, so load its real source stylesheet after the built
  // application styles just as the route chunk does in production.
  await page.addStyleTag({ content: sygTasksStyles })
  await page.locator('#root').evaluate((root, selectedTheme) => {
    const fixtureRoot = root.cloneNode(false) as HTMLElement
    root.replaceWith(fixtureRoot)
    document.documentElement.dataset.theme = selectedTheme
    document.documentElement.style.colorScheme = selectedTheme
    fixtureRoot.innerHTML = `
      <div class="workspace" style="margin-left:0">
        <main id="main-content">
          <section aria-labelledby="sygtasks-title" class="sygtasks-workspace">
            <header class="sygtasks-header">
              <div>
                <span aria-hidden="true" class="sygtasks-header__icon">✓</span>
                <div>
                  <p>SygShift work management</p>
                  <h1 id="sygtasks-title">SygTasks</h1>
                  <span>Plan work, assign ownership, and keep progress visible.</span>
                </div>
              </div>
              <div class="sygtasks-header__actions">
                <button class="secondary-button" type="button">Refresh</button>
                <button type="button">New board</button>
              </div>
            </header>

            <nav aria-label="SygTasks workspaces" class="sygtasks-mode-tabs">
              <button aria-current="page" type="button">My Work <span>0</span></button>
              <button type="button">Boards <span>1</span></button>
            </nav>

            <div class="sygtasks-layout">
              <main class="sygtasks-main">
                <header class="sygtasks-main__heading">
                  <div><p>Personal focus</p><h2>My Work</h2><span>Tasks you own, follow, or were assigned.</span></div>
                </header>
                <div class="sygtasks-toolbar">
                  <label class="sygtasks-toolbar__search">
                    <span aria-hidden="true">⌕</span>
                    <span class="visually-hidden">Search tasks</span>
                    <input placeholder="Search tasks, people, or labels" />
                  </label>
                  <label class="sygtasks-toolbar__filter">
                    <span class="visually-hidden">Filter by status</span>
                    <select><option>All statuses</option></select>
                  </label>
                  <label class="sygtasks-toolbar__filter">
                    <span class="visually-hidden">Filter by priority</span>
                    <select><option>All priorities</option></select>
                  </label>
                  <div aria-label="Task view" role="group">
                    <button aria-pressed="true" type="button">Board</button>
                    <button aria-pressed="false" type="button">List</button>
                  </div>
                </div>
                <div data-task-content>
                  <div class="sygtasks-empty">
                    <span aria-hidden="true">☷</span>
                    <h3>No work here yet</h3>
                    <p>New and assigned work will appear here.</p>
                  </div>
                </div>
              </main>
            </div>
          </section>

          <dialog aria-describedby="task-dialog-description" aria-labelledby="task-dialog-title" class="modal-dialog sygtasks-dialog">
            <div class="modal-dialog__heading">
              <div class="modal-dialog__heading-copy">
                <span class="modal-dialog__eyebrow">New workspace</span>
                <h2 id="task-dialog-title">Create a SygTasks board</h2>
                <p id="task-dialog-description">Organize personal work or coordinate a shared team.</p>
              </div>
              <button aria-label="Close dialog" class="modal-close" type="button">×</button>
            </div>
            <form>
              <div class="sygtasks-form-grid">
                <label class="sygtasks-field"><span>Board name</span><input autofocus required /></label>
                <label class="sygtasks-field"><span>Who is this for?</span><select><option>Just me</option></select></label>
              </div>
              <label class="sygtasks-field"><span>Description <small>Optional</small></span><textarea rows="4"></textarea></label>
              <div class="sygtasks-dialog__actions">
                <button class="secondary-button" type="button">Cancel</button>
                <button type="submit">Create board</button>
              </div>
            </form>
          </dialog>
        </main>
      </div>`
  }, theme)
}

async function installPopulatedState(page: Page) {
  await page.locator('[data-task-content]').evaluate((content) => {
    content.innerHTML = `
      <div aria-label="Kanban board" class="sygtasks-kanban">
        <section class="sygtasks-column sygtasks-column--ready">
          <header><h3>Ready</h3><span>1</span></header>
          <div>
            <article class="sygtasks-card sygtasks-card--high">
              <button aria-label="Open Confirm weekend coverage" class="sygtasks-card__open" type="button">
                <strong>Confirm weekend coverage</strong>
                <span class="sygtasks-card__description">Review the open post and confirm an available officer.</span>
              </button>
              <div aria-label="Task status colors" class="sygtasks-card__meta">
                <span class="sygtasks-chip sygtasks-chip--status-ready">Ready</span>
                <span class="sygtasks-chip sygtasks-chip--status-in_progress">In progress</span>
                <span class="sygtasks-chip sygtasks-chip--status-blocked">Blocked</span>
                <span class="sygtasks-chip sygtasks-chip--status-review">Review</span>
                <span class="sygtasks-chip sygtasks-chip--status-done">Done</span>
                <span class="sygtasks-chip sygtasks-chip--priority-urgent">Urgent</span>
                <span class="sygtasks-chip sygtasks-chip--priority-high">High</span>
                <span class="sygtasks-chip sygtasks-chip--priority-low">Low</span>
              </div>
              <div class="sygtasks-card__footer"><span>Jordan Brown</span><span>1/2 complete</span><span>1 comment</span></div>
              <label class="sygtasks-card__status"><span class="visually-hidden">Change status for Confirm weekend coverage</span><select><option>Ready</option></select></label>
            </article>
          </div>
        </section>
      </div>`
  })
}

async function contrastFor(locator: Locator) {
  return locator.evaluate((element) => {
    function parseColor(value: string) {
      const values = value.match(/-?\d*\.?\d+/g)?.map(Number) ?? []
      if (value.startsWith('color(srgb')) {
        return { r: values[0] * 255, g: values[1] * 255, b: values[2] * 255, a: values[3] ?? 1 }
      }
      return { r: values[0] ?? 0, g: values[1] ?? 0, b: values[2] ?? 0, a: values[3] ?? 1 }
    }
    function composite(foreground: ReturnType<typeof parseColor>, background: ReturnType<typeof parseColor>) {
      const alpha = foreground.a + background.a * (1 - foreground.a)
      if (!alpha) return { r: 0, g: 0, b: 0, a: 0 }
      return {
        r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
        g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
        b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
        a: alpha,
      }
    }
    function luminance(color: ReturnType<typeof parseColor>) {
      const channel = (value: number) => {
        const normalized = value / 255
        return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
    }

    const foreground = parseColor(getComputedStyle(element).color)
    let background = { r: 0, g: 0, b: 0, a: 0 }
    for (let current: Element | null = element; current && background.a < 0.999; current = current.parentElement) {
      background = composite(background, parseColor(getComputedStyle(current).backgroundColor))
    }
    const foregroundLuminance = luminance(foreground)
    const backgroundLuminance = luminance(background)
    return {
      background,
      foreground,
      ratio: (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
        / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05),
    }
  })
}

async function expectReadable(locator: Locator, label: string) {
  const result = await contrastFor(locator)
  expect(
    result.ratio,
    `${label} contrast was ${result.ratio.toFixed(2)}:1; foreground ${JSON.stringify(result.foreground)}, background ${JSON.stringify(result.background)}`,
  ).toBeGreaterThanOrEqual(4.5)
}

for (const theme of ['light', 'dark'] as const) {
  for (const scenario of scenarios) {
    test(`SygTasks stays readable and contained in ${theme} ${scenario.label} mode`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: scenario.width, height: scenario.height })
      await installSygTasksFixture(page, theme)

      for (const label of ['Search tasks', 'Filter by status', 'Filter by priority']) {
        expect(sygTasksPageSource).toContain(`<span className="visually-hidden">${label}</span>`)
      }
      await expect(page.getByRole('textbox', { name: 'Search tasks' })).toBeVisible()
      await expect(page.getByRole('combobox', { name: 'Filter by status' })).toBeVisible()
      await expect(page.getByRole('combobox', { name: 'Filter by priority' })).toBeVisible()

      const helperLabels = page.locator('.sygtasks-toolbar .visually-hidden')
      await expect(helperLabels).toHaveCount(3)
      for (const helper of await helperLabels.all()) {
        const presentation = await helper.evaluate((element) => {
          const style = getComputedStyle(element)
          const bounds = element.getBoundingClientRect()
          return { height: bounds.height, overflow: style.overflow, position: style.position, width: bounds.width }
        })
        expect(presentation.position).toBe('absolute')
        expect(presentation.overflow).toBe('hidden')
        expect(presentation.width).toBeLessThanOrEqual(1)
        expect(presentation.height).toBeLessThanOrEqual(1)
      }

      for (const [selector, label] of [
        ['.sygtasks-header h1', 'workspace title'],
        ['.sygtasks-header h1 + span', 'workspace summary'],
        ['.sygtasks-main__heading h2', 'My Work title'],
        ['.sygtasks-main__heading h2 + span', 'My Work summary'],
        ['.sygtasks-toolbar input', 'search input'],
        ['.sygtasks-toolbar__filter select', 'status filter'],
        ['.sygtasks-empty h3', 'empty-state title'],
        ['.sygtasks-empty p', 'empty-state guidance'],
      ] as const) {
        await expectReadable(page.locator(selector).first(), label)
      }

      const mainPalette = await page.locator('.sygtasks-main').evaluate((element) => {
        const values = (value: string) => value.match(/-?\d*\.?\d+/g)?.map(Number) ?? []
        const normalize = (value: string) => {
          const channels = values(value)
          return value.startsWith('color(srgb') ? channels.slice(0, 3).map((channel) => channel * 255) : channels.slice(0, 3)
        }
        const style = getComputedStyle(element)
        return { background: normalize(style.backgroundColor), foreground: normalize(style.color) }
      })
      expect(mainPalette.background).toHaveLength(3)
      expect(mainPalette.foreground).toHaveLength(3)
      if (theme === 'dark') {
        expect(Math.max(...mainPalette.background)).toBeLessThan(80)
        expect(Math.min(...mainPalette.foreground)).toBeGreaterThan(180)
      } else {
        expect(Math.min(...mainPalette.background)).toBeGreaterThan(220)
        expect(Math.max(...mainPalette.foreground)).toBeLessThan(100)
      }

      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
      expect(await page.locator('.sygtasks-workspace').evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      expect((await new AxeBuilder({ page }).include('.sygtasks-workspace').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
      await page.screenshot({ path: testInfo.outputPath(`sygtasks-empty-${theme}-${scenario.width}.png`), fullPage: true })

      await installPopulatedState(page)
      const chips = page.locator('.sygtasks-chip')
      await expect(chips).toHaveCount(8)
      for (const chip of await chips.all()) await expectReadable(chip, `status chip “${await chip.textContent()}”`)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
      expect((await new AxeBuilder({ page }).include('.sygtasks-workspace').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])

      const dialogElement = page.locator('dialog.sygtasks-dialog')
      await dialogElement.evaluate((element: HTMLDialogElement) => element.showModal())
      const dialog = page.getByRole('dialog', { name: 'Create a SygTasks board' })
      await expect(dialog).toBeVisible()
      await expectReadable(dialog.getByRole('heading'), 'dialog title')
      await expectReadable(dialog.getByText('Organize personal work or coordinate a shared team.'), 'dialog summary')
      const viewport = page.viewportSize()
      const bounds = await dialog.boundingBox()
      expect(viewport).not.toBeNull()
      expect(bounds).not.toBeNull()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.y).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport!.width)
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport!.height)
      expect(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      await expect(dialog.getByRole('button', { name: 'Create board' })).toBeInViewport()
      expect((await new AxeBuilder({ page }).include('.sygtasks-dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
      await page.screenshot({ path: testInfo.outputPath(`sygtasks-dialog-${theme}-${scenario.width}.png`), fullPage: true })
    })
  }
}
