import { expect, test } from '@playwright/test'

test('Dispatch timekeeping modes stay clear and usable', async ({ page }) => {
  await page.goto('/')
  await page.locator('#root').evaluate((root) => {
    root.innerHTML = `
      <main style="max-width:900px;margin:24px auto;padding:0 18px">
        <form class="request-form schedule-builder__form">
          <div class="form-grid">
            <fieldset class="schedule-builder-dispatch-mode" data-testid="dispatch-mode">
              <legend>Dispatch timekeeping</legend>
              <label class="is-selected">
                <input checked name="dispatchMode" type="radio" />
                <span><strong>Primary paid shift</strong><small>The employee clocks in. Scheduled hours, missed-punch monitoring, automatic clock-out, overtime, and payroll all apply.</small></span>
              </label>
              <label>
                <input name="dispatchMode" type="radio" />
                <span><strong>Concurrent phone duty</strong><small>Use only when the employee is already working another Site/Post shift. This does not create duplicate paid hours.</small></span>
              </label>
            </fieldset>
          </div>
        </form>
        <article class="shift-card" style="margin-top:18px;max-width:260px">
          <div class="shift-card__heading shift-card__heading--dispatch"><strong>8:00 AM (08:00) – 4:30 PM (16:30)</strong><span class="shift-tag shift-tag--dispatch">Paid dispatch shift</span></div>
        </article>
      </main>`
  })

  const mode = page.getByTestId('dispatch-mode')
  await expect(mode.getByText('Primary paid shift')).toBeVisible()
  await expect(mode.getByText('Concurrent phone duty')).toBeVisible()
  await expect(page.getByText('Paid dispatch shift')).toBeVisible()
  expect(await mode.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)

  const choices = mode.locator('label')
  const firstBox = (await choices.nth(0).boundingBox())!
  const secondBox = (await choices.nth(1).boundingBox())!
  if (page.viewportSize()!.width > 720) {
    expect(Math.abs(firstBox.y - secondBox.y)).toBeLessThan(4)
  } else {
    expect(secondBox.y).toBeGreaterThan(firstBox.y + firstBox.height - 1)
  }
})
