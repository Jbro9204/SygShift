import { expect, test } from '@playwright/test'

test('HR workspace and modal remain polished and contained', async ({ page }, testInfo) => {
  await page.goto('/')

  await page.locator('#root').evaluate((root) => {
    root.innerHTML = `
      <main class="hr-people-page" aria-label="HR presentation fixture">
        <section class="hr-people-hero">
          <p class="eyebrow">HR &amp; FINANCE</p>
          <h1>People Operations</h1>
          <p>Review employee records, onboarding readiness, and protected documents.</p>
          <button class="primary-action" type="button">Add employee</button>
        </section>
        <section class="hr-people-panel">
          <div class="hr-people-panel__heading">
            <div><p class="eyebrow">WORKFORCE</p><h2>Employee worklist</h2></div>
            <button class="secondary-button" type="button">View filters</button>
          </div>
          <div class="hr-people-row">
            <div><strong>Jordan Brown</strong><p>IT and Business Development Engineer</p></div>
            <span class="status-pill status-pill--ready">Active</span>
            <button class="secondary-button" type="button">Open profile</button>
          </div>
        </section>
      </main>
      <dialog class="modal-dialog modal-dialog--hr-onboarding" open aria-labelledby="fixture-modal-title">
        <div class="modal-dialog__heading">
          <div><h2 id="fixture-modal-title">Start employee onboarding</h2><p>Confirm the employee, start date, and required onboarding package.</p></div>
          <button class="modal-close" aria-label="Close dialog" type="button">×</button>
        </div>
        <form class="request-form">
          <div class="form-grid form-grid--two-columns">
            <label>Employee<input value="Jordan Brown" /></label>
            <label>Start date<input type="date" value="2026-09-01" /></label>
          </div>
          <label class="field-stack">Onboarding note<textarea>Prepare the standard employee package.</textarea></label>
          <div class="modal-actions">
            <button class="secondary-button" type="button">Cancel</button>
            <button class="primary-action" type="button">Start onboarding</button>
          </div>
        </form>
      </dialog>`
  })

  const dialog = page.getByRole('dialog')
  const dialogBox = await dialog.boundingBox()
  const headingBox = await dialog.locator('.modal-dialog__heading').boundingBox()
  const viewport = page.viewportSize()

  expect(dialogBox).not.toBeNull()
  expect(headingBox).not.toBeNull()
  expect(viewport).not.toBeNull()
  expect(dialogBox!.x).toBeGreaterThanOrEqual(4)
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(viewport!.width - 4)
  expect(headingBox!.x - dialogBox!.x).toBeGreaterThanOrEqual(0)

  const headingPadding = await dialog.locator('.modal-dialog__heading').evaluate((element) => {
    const styles = getComputedStyle(element)
    return { left: Number.parseFloat(styles.paddingLeft), right: Number.parseFloat(styles.paddingRight) }
  })
  expect(headingPadding.left).toBeGreaterThanOrEqual(16)
  expect(headingPadding.right).toBeGreaterThanOrEqual(16)

  for (const control of await dialog.locator('button, input, select, textarea').all()) {
    const box = await control.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.height).toBeGreaterThanOrEqual(42)
    expect(box!.x).toBeGreaterThanOrEqual(dialogBox!.x)
    expect(box!.x + box!.width).toBeLessThanOrEqual(dialogBox!.x + dialogBox!.width + 1)
  }

  const noteField = dialog.locator('textarea')
  const noteBox = await noteField.boundingBox()
  const formBox = await dialog.locator('.request-form').boundingBox()
  expect(noteBox).not.toBeNull()
  expect(formBox).not.toBeNull()
  expect(noteBox!.width).toBeGreaterThanOrEqual(formBox!.width * 0.95)

  const documentOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(documentOverflow).toBeLessThanOrEqual(1)

  await page.screenshot({ path: testInfo.outputPath('hr-presentation.png'), fullPage: true })
})
