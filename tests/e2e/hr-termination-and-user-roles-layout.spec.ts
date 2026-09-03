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

test('User Accounts separates workforce behavior from specialized access without duplicate role lists', async ({ page }, testInfo) => {
  await page.goto('/')

  await page.locator('#root').evaluate((root) => {
    root.innerHTML = `
      <main style="width:min(760px,calc(100% - 24px));margin:24px auto">
        <h1>User Accounts role assignment</h1>
        <form class="request-form user-admin-form">
          <label><span>Workforce role</span><select><option>Supervisor</option></select><small>Controls Schedule, Time &amp; Attendance, and operational routing.</small></label>
          <fieldset class="user-admin-access-roles">
            <legend>Department &amp; management access</legend>
            <p>Add a specialized access package only when this employee needs a protected department or management workspace.</p>
            <div class="user-admin-access-roles__assigned">
              <div class="user-admin-access-role is-selected"><span><strong>Human Resources Manager</strong><small>Specialized access · MFA required</small></span><button class="secondary-button secondary-button--small" type="button">Remove</button></div>
            </div>
            <div class="user-admin-access-roles__add"><label><span>Add specialized access</span><select aria-label="Add specialized access"><option>Choose a role</option><option>Human Resources Employee · MFA required</option><option>Operations Manager · MFA required</option></select></label><button class="secondary-button" type="button">Add access</button></div>
          </fieldset>
        </form>
      </main>`
  })

  await expect(page.getByText('Human Resources Manager')).toBeVisible()
  await expect(page.getByLabel('Add specialized access')).not.toContainText('Admin')
  await expect(page.getByLabel('Add specialized access')).not.toContainText('Supervisor')
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('user-accounts-role-assignment.png'), fullPage: true })
})
