import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('sensitive permission review stays compact and independently scrollable', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.locator('#root').evaluate((root) => {
    const categories = Array.from({ length: 12 }, (_, index) => `Permission group ${index + 1}`)
    root.innerHTML = `
      <dialog class="modal-dialog access-modal access-modal--confirmation" open aria-labelledby="sensitive-title">
        <h1 class="visually-hidden">Roles & Permissions</h1>
        <div class="modal-dialog__heading"><div><h2 id="sensitive-title">Confirm sensitive access</h2><p>This employee will receive protected permissions.</p></div><button class="modal-close" aria-label="Close dialog">×</button></div>
        <div class="access-confirmation-review">
          <div class="access-confirmation-summary"><span aria-hidden="true">!</span><span><strong>48 sensitive permissions will be added</strong><small>Grouped into 12 sections. Open a section only when you need to review its details.</small></span></div>
          <div class="access-confirmation-groups" aria-label="Sensitive permission groups">
            ${categories.map((category) => `<details class="access-confirmation-group"><summary><span><strong>${category}</strong><small>4 permissions</small></span><span aria-hidden="true">⌄</span></summary></details>`).join('')}
          </div>
        </div>
        <div class="modal-actions"><button class="access-control-button access-control-button--secondary">Go back</button><button class="access-control-button access-control-button--primary">Confirm and save</button></div>
      </dialog>`
  })

  const dialog = page.getByRole('dialog')
  const groupList = page.getByLabel('Sensitive permission groups')
  const dialogBox = await dialog.boundingBox()
  const viewport = page.viewportSize()
  expect(dialogBox).not.toBeNull()
  expect(viewport).not.toBeNull()
  expect(dialogBox!.height).toBeLessThan(viewport!.height)
  expect(await groupList.evaluate((element) => element.scrollHeight)).toBeGreaterThan(
    await groupList.evaluate((element) => element.clientHeight),
  )
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('sensitive-permission-review.png'), fullPage: true })
})

test('role library footer remains inside its card with clear banner spacing', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.locator('#root').evaluate((root) => {
    const roles = Array.from({ length: 10 }, (_, index) => `Role ${index + 1}`)
    root.innerHTML = `
      <main class="page-stack access-control-page" style="width:min(1100px,calc(100% - 24px));margin:24px auto">
        <h1 class="visually-hidden">Roles & Permissions</h1>
        <section class="access-role-mode">
          <aside class="access-role-directory">
            <div class="access-panel-heading"><div><p class="eyebrow">Role library</p><h2>Choose a role</h2></div><span>10</span></div>
            <div class="access-role-list">${roles.map((role) => `<button class="role-tile"><span><strong>${role}</strong><small>Custom role</small></span><span class="role-tile__meta"><em>12 perms</em><em>1 person</em></span></button>`).join('')}</div>
            <button class="access-control-button access-control-button--primary access-role-create">Create role</button>
          </aside>
          <section class="access-workspace-card"><h2>Permission workspace</h2></section>
        </section>
        <section class="access-security-note access-security-note--wide"><span aria-hidden="true">✓</span><div><strong>Rule of record</strong><p>Role permissions provide the baseline.</p></div></section>
      </main>`
  })

  const directory = page.locator('.access-role-directory')
  const createButton = page.getByRole('button', { name: 'Create role' })
  const banner = page.getByText('Rule of record').locator('..').locator('..')
  const directoryBox = await directory.boundingBox()
  const buttonBox = await createButton.boundingBox()
  const bannerBox = await banner.boundingBox()
  expect(directoryBox).not.toBeNull()
  expect(buttonBox).not.toBeNull()
  expect(bannerBox).not.toBeNull()
  expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(directoryBox!.y + directoryBox!.height)
  expect(bannerBox!.y - (directoryBox!.y + directoryBox!.height)).toBeGreaterThanOrEqual(16)
  expect(await page.locator('main').evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('role-library-footer.png'), fullPage: true })
})
