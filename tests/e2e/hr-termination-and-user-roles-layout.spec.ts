import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('HR termination confirmation remains contained and unmistakable', async ({ page }, testInfo) => {
  await page.goto('/')

  await page.locator('#root').evaluate((root) => {
    root.innerHTML = `
      <dialog class="modal-dialog hr-termination-modal" open aria-labelledby="termination-title">
        <div class="modal-dialog__heading"><div><h2 id="termination-title">Terminate employment · Sample Employee</h2><p>This protected HR action immediately ends access while preserving history.</p></div></div>
        <form>
          <div class="hr-termination-modal__warning" role="alert"><span aria-hidden="true">!</span><div><strong>This action takes effect immediately.</strong><p>The employee will be marked separated, their login and remembered devices will be disabled, and current or future assigned shifts and pending shift requests will be released.</p></div></div>
          <label>Termination date<input type="date" value="2026-09-02" /><small>Future dates belong in the Offboarding workflow.</small></label>
          <label>Required HR reason<textarea rows="4">Approved employment separation.</textarea></label>
          <label>Confirm employee username<input value="sampleemployee" /><small>Enter sampleemployee without the @ symbol.</small></label>
          <div class="modal-actions"><button class="secondary-button" type="button">Keep employee active</button><button class="danger-action" type="button">Terminate employment</button></div>
        </form>
      </dialog>`
  })

  const dialog = page.getByRole('dialog')
  const dialogBox = await dialog.boundingBox()
  const viewport = page.viewportSize()
  expect(dialogBox).not.toBeNull()
  expect(viewport).not.toBeNull()
  expect(dialogBox!.x).toBeGreaterThanOrEqual(4)
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(viewport!.width - 4)

  for (const control of await dialog.locator('button, input, textarea').all()) {
    const box = await control.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.height).toBeGreaterThanOrEqual(38)
  }

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('hr-termination-dialog.png'), fullPage: true })
})

for (const theme of ['light', 'dark']) {
  test(`User Accounts uses one actual searchable role list in ${theme} mode`, async ({ page }, testInfo) => {
    await page.goto(`http://127.0.0.1:4189/tests/fixtures/roles-ui.html?theme=${theme}`)
    await expect(page.getByRole('group', { name: 'Roles', exact: true })).toHaveCount(1)
    await expect(page.getByText('Workforce role')).toHaveCount(0)
    await expect(page.getByText('Add specialized access')).toHaveCount(0)
    await expect(page.getByRole('checkbox', { name: 'Supervisor', exact: true })).toBeChecked()
    await expect(page.getByRole('checkbox', { name: 'Human Resources Manager', exact: true })).toBeChecked()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    await page.getByRole('searchbox', { name: 'Find a role' }).fill('operations')
    await expect(page.getByRole('checkbox', { name: 'Operations Manager', exact: true })).toBeVisible()
    await page.getByRole('checkbox', { name: 'Operations Manager', exact: true }).check()
    await page.getByRole('button', { name: 'Save employee', exact: true }).click()
    const review = page.getByRole('dialog', { name: 'Review role changes' })
    await expect(review).toBeVisible()
    await expect(review).toContainText('Operations Manager · MFA required')
    await expect(review.getByRole('button', { name: 'Confirm & save employee' })).toBeInViewport()
    await review.getByRole('button', { name: 'Confirm & save employee' }).click()
    await expect(page.getByLabel('Saved role result')).toContainText('ops-role')
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`user-accounts-role-assignment-${theme}.png`), fullPage: true })
  })
}
