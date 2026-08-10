import { expect, test } from '@playwright/test'

test('Users & Access controls remain contained and separated from the filter row', async ({ page }) => {
  await page.goto('/')

  await page.locator('#root').evaluate((root) => {
    root.innerHTML = `
      <main style="max-width: 1372px; margin: 32px auto; padding: 0 20px;">
        <section class="user-admin-toolbar" aria-label="Users and access controls">
          <label><span class="sr-only">Search employees</span><input aria-label="Search employees" value="matth" /></label>
          <label>Role<select aria-label="Role"><option>All roles</option></select></label>
          <label>Status<select aria-label="Status"><option>Active</option></select></label>
          <label>Login<select aria-label="Login"><option>All logins</option></select></label>
          <label>Activity<select aria-label="Activity"><option>All activity</option></select></label>
          <div class="user-admin-toolbar__actions">
            <button class="secondary-button" type="button">Add employee</button>
            <button class="primary-action" type="button">Create missing logins</button>
            <button class="secondary-button" type="button">Email new logins</button>
          </div>
        </section>
      </main>`
  })

  const toolbar = page.getByRole('region', { name: 'Users and access controls' })
  const toolbarBox = await toolbar.boundingBox()
  expect(toolbarBox).not.toBeNull()

  const overflow = await toolbar.evaluate((element) => element.scrollWidth - element.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)

  const buttons = await toolbar.getByRole('button').all()
  const buttonBoxes = await Promise.all(buttons.map((button) => button.boundingBox()))
  for (const box of buttonBoxes) {
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(toolbarBox!.x)
    expect(box!.x + box!.width).toBeLessThanOrEqual(toolbarBox!.x + toolbarBox!.width + 1)
  }

  const actionRowBox = await toolbar.locator('.user-admin-toolbar__actions', {}).boundingBox()
  const searchBox = await toolbar.getByLabel('Search employees').boundingBox()
  expect(actionRowBox).not.toBeNull()
  expect(searchBox).not.toBeNull()
  expect(actionRowBox!.y).toBeGreaterThanOrEqual(searchBox!.y + searchBox!.height)
})
