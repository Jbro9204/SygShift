import { expect, test } from '@playwright/test'

test('role permission category controls stay clear and contained', async ({ page }, testInfo) => {
  await page.goto('/')

  await page.locator('#root').evaluate((root) => {
    const fixtureRoot = root.cloneNode(false) as HTMLElement
    root.replaceWith(fixtureRoot)
    fixtureRoot.innerHTML = `
      <main class="access-control-page">
        <section class="access-workspace-card">
          <div class="access-workspace-card__header">
            <div><p class="eyebrow">Permission workspace</p><h2>Human Resources Manager</h2></div>
          </div>
          <fieldset class="access-home-experience">
            <legend>Home experience</legend>
            <p>Choose the landing page employees receive after they sign in.</p>
            <div class="access-home-experience__options">
              <label class="access-home-experience__option">
                <input name="homeExperience" type="radio" value="basic" />
                <span><strong>Basic Home</strong><small>Personal schedule, time, requests, announcements, and assigned work.</small></span>
              </label>
              <label class="access-home-experience__option access-home-experience__option--selected">
                <input checked name="homeExperience" type="radio" value="operations" />
                <span><strong>Operations Home</strong><small>Company coverage, staffing totals, priority queues, and management workspaces.</small></span>
              </label>
            </div>
          </fieldset>
          <div class="access-permission-accordion">
            <section class="access-permission-group access-permission-group--open">
              <button class="access-permission-group__header" type="button">
                <span><strong>HR &amp; Finance</strong><small>54 of 54 enabled</small></span>
              </button>
              <div class="access-permission-group__body">
                <div class="access-permission-group__bulk" aria-label="HR &amp; Finance category controls">
                  <span><strong>Category controls</strong><small>54 permissions</small></span>
                  <button type="button">Select all</button>
                  <button type="button">Clear all</button>
                </div>
                <label class="access-permission-row access-permission-row--selected">
                  <span><strong>Manage HR employee records</strong></span><span></span><span></span><input checked type="checkbox" />
                </label>
              </div>
            </section>
          </div>
        </section>
      </main>`
  })

  const controls = page.getByLabel('HR & Finance category controls')
  await expect(page.getByText('Basic Home', { exact: true })).toBeVisible()
  await expect(page.getByText('Operations Home', { exact: true })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Operations Home' })).toBeChecked()
  await expect(controls).toBeVisible()
  await expect(controls.getByRole('button', { name: 'Select all' })).toBeVisible()
  await expect(controls.getByRole('button', { name: 'Clear all' })).toBeVisible()

  const controlsBox = await controls.boundingBox()
  const cardBox = await page.locator('.access-workspace-card').boundingBox()
  expect(controlsBox).not.toBeNull()
  expect(cardBox).not.toBeNull()
  expect(controlsBox!.x).toBeGreaterThanOrEqual(cardBox!.x)
  expect(controlsBox!.x + controlsBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width + 1)

  for (const button of await controls.getByRole('button').all()) {
    const box = await button.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.height).toBeGreaterThanOrEqual(38)
  }

  const documentOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(documentOverflow).toBeLessThanOrEqual(1)
  await page.screenshot({ path: testInfo.outputPath('access-role-category-controls.png'), fullPage: true })

  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await expect(page.getByText('Operations Home', { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('access-role-category-controls-dark.png'), fullPage: true })
})
