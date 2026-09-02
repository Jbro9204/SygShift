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

test('User Accounts complete role library stays compact and scrollable', async ({ page }, testInfo) => {
  await page.goto('/')

  await page.locator('#root').evaluate((root) => {
    const roles = ['Admin', 'Dispatcher', 'Guard', 'Recruiting & Licensing', 'Scheduler', 'Supervisor', 'Human Resources Employee', 'Human Resources Manager', 'Operations Manager']
    root.innerHTML = `
      <main style="width:min(760px,calc(100% - 24px));margin:24px auto">
        <h1>User Accounts role assignment</h1>
        <form class="request-form user-admin-form">
          <fieldset class="user-admin-access-roles">
            <legend>Additional access roles</legend>
            <p>The primary role is inherited automatically. Select any other active role this employee should also receive.</p>
            <div class="user-admin-access-roles__grid">
              ${roles.map((role, index) => `<label class="user-admin-access-role${index === 7 ? ' is-selected' : ''}"><input ${index === 7 ? 'checked' : ''} type="checkbox" /><span><strong>${role}</strong><small>${index > 5 ? 'Specialized role' : 'Built-in role'}${index === 0 || index > 5 ? ' · MFA required' : ''}</small></span></label>`).join('')}
            </div>
          </fieldset>
        </form>
      </main>`
  })

  const roleGrid = page.locator('.user-admin-access-roles__grid')
  await expect(roleGrid.getByText('Human Resources Manager')).toBeVisible()
  await expect(roleGrid.getByText('Operations Manager')).toBeVisible()
  expect(await roleGrid.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('user-accounts-role-library.png'), fullPage: true })
})
