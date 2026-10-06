import { expect, test } from '@playwright/test'

test('EP and TRUEP controls remain readable on desktop and phone layouts', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim().length > 0)
  await page.locator('#root').evaluate((root) => {
    const fixtureRoot = root.cloneNode(false) as HTMLElement
    root.replaceWith(fixtureRoot)
    fixtureRoot.innerHTML = `
      <main style="display:grid;gap:20px;max-width:980px;margin:24px auto;padding:0 16px">
        <form class="request-form schedule-builder__form">
          <div class="form-grid">
            <fieldset class="schedule-payroll-category" data-testid="payroll-category">
              <legend>Payroll classification</legend>
              <label class="is-selected"><input checked name="payrollCategory" type="radio" /><span><strong>Regular</strong><small>Default payroll classification.</small></span></label>
              <label><input name="payrollCategory" type="radio" /><span><strong>EP</strong><small>Separates these worked hours into the EP payroll column.</small></span></label>
              <label><input name="payrollCategory" type="radio" /><span><strong>TRUEP</strong><small>Separates these worked hours into the TRUEP payroll column.</small></span></label>
              <p>Classification controls separate payroll export columns. Finance and Payroll continue to control rates and overtime treatment.</p>
            </fieldset>
          </div>
        </form>

        <fieldset class="site-editor-section">
          <legend>Payroll classifications</legend>
          <label class="check-field site-payroll-toggle" data-testid="site-toggle"><input checked type="checkbox" /><span><strong>Enable EP / TRUEP classifications for this site</strong><small>Regular remains the default. Schedulers may classify individual shifts as EP or TRUEP.</small></span></label>
        </fieldset>

        <article class="shift-card" style="max-width:280px">
          <div class="shift-card__heading"><strong>9:00 AM (09:00) – 5:00 PM (17:00)</strong><span class="shift-tag shift-tag--payroll">EP</span></div>
        </article>
      </main>`
  })

  const selector = page.getByTestId('payroll-category')
  await expect(selector.getByText('Regular', { exact: true })).toBeVisible()
  await expect(selector.getByText('EP', { exact: true })).toBeVisible()
  await expect(selector.getByText('TRUEP', { exact: true })).toBeVisible()
  await expect(page.getByTestId('site-toggle')).toBeVisible()
  await expect(page.locator('.shift-tag--payroll')).toHaveText('EP')

  expect(await selector.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)

  const choices = selector.locator('label')
  for (let index = 0; index < await choices.count(); index += 1) {
    expect((await choices.nth(index).boundingBox())!.height).toBeGreaterThanOrEqual(44)
  }
  expect((await page.getByTestId('site-toggle').boundingBox())!.height).toBeGreaterThanOrEqual(44)

  const first = (await choices.nth(0).boundingBox())!
  const second = (await choices.nth(1).boundingBox())!
  const firstRadio = (await choices.nth(0).locator('input').boundingBox())!
  const firstLabel = (await choices.nth(0).locator('strong').boundingBox())!
  expect(firstRadio.x + firstRadio.width).toBeLessThan(firstLabel.x)
  expect(Math.abs(firstRadio.y - firstLabel.y)).toBeLessThan(12)
  if (page.viewportSize()!.width > 720) {
    expect(Math.abs(first.y - second.y)).toBeLessThan(4)
  } else {
    expect(second.y).toBeGreaterThan(first.y + first.height - 1)
  }

  await page.screenshot({ path: testInfo.outputPath('payroll-category-layout.png'), fullPage: true })
})
