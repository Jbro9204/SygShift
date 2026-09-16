import { expect, test } from '@playwright/test'

test('User Accounts controls and presence remain contained at desktop and mobile widths', async ({ page }) => {
  await page.goto('/')

  await page.locator('#root').evaluate((root) => {
    const fixtureRoot = root.cloneNode(false) as HTMLElement
    root.replaceWith(fixtureRoot)
    fixtureRoot.innerHTML = `
      <main style="max-width: 1372px; margin: 32px auto; padding: 0 20px;">
        <section class="user-admin-toolbar" aria-label="User account controls">
          <label><span class="sr-only">Search employees</span><input aria-label="Search employees" value="matth" /></label>
          <label>Role<select aria-label="Role"><option>All roles</option></select></label>
          <label>Status<select aria-label="Status"><option>Active</option></select></label>
          <label>Login<select aria-label="Login"><option>All logins</option></select></label>
          <label>Sign-in history<select aria-label="Sign-in history"><option>All sign-in history</option></select></label>
          <label>Presence<select aria-label="Presence"><option>All presence</option></select></label>
          <div class="user-admin-toolbar__actions">
            <button class="secondary-button" type="button">Add employee</button>
            <button class="primary-action" type="button">Create missing logins</button>
            <button class="secondary-button" type="button">Email new logins</button>
          </div>
        </section>
        <section class="user-admin-table" role="table" aria-label="User accounts and login access">
          <div class="user-admin-row user-admin-row--header" role="row">
            <span role="columnheader">Employee</span><span role="columnheader">Access &amp; Employment</span>
            <span role="columnheader">Login</span><span role="columnheader">Presence</span>
            <span role="columnheader">Last Activity</span><span role="columnheader">Manage</span>
          </div>
          <div class="user-admin-row" role="row">
            <div role="cell" data-label="Employee"><strong>Jordan Brown</strong><span>SYG-1001 · @jbrown</span></div>
            <div role="cell" data-label="Access &amp; Employment"><strong>Admin</strong><small>Active</small></div>
            <div role="cell" data-label="Login"><strong>Active login</strong><small>Activated</small></div>
            <div class="user-admin-presence" role="cell" data-label="Presence"><span class="account-presence account-presence--active"><i></i>Active now</span><small>Last active just now</small></div>
            <div class="user-admin-last-activity" role="cell" data-label="Last Activity"><strong>09/16/2026, 9:00 AM</strong><small>No remembered devices</small></div>
            <div role="cell" data-label="Manage"><button class="secondary-button" type="button">Manage</button></div>
          </div>
        </section>
      </main>`
  })

  const toolbar = page.getByRole('region', { name: 'User account controls' })
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

  const table = page.getByRole('table', { name: 'User accounts and login access' })
  const assertNoHorizontalOverflow = async () => {
    expect(await page.locator('body').evaluate((body) => body.scrollWidth - body.clientWidth)).toBeLessThanOrEqual(1)
    expect(await table.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  }

  await assertNoHorizontalOverflow()
  await expect(page.getByText('Active now')).toBeVisible()

  await page.setViewportSize({ width: 900, height: 900 })
  await assertNoHorizontalOverflow()
  await expect(page.getByLabel('Presence')).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  await assertNoHorizontalOverflow()
  await expect(page.getByRole('button', { name: 'Manage' })).toBeVisible()
})
