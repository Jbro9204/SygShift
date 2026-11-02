import { expect, test, type Page } from '@playwright/test'

const requestId = '20000000-0000-4000-8000-000000000001'
async function openOnboarding(page: Page, scenario: string) {
  // Defense in depth: the isolated component cannot reach production services.
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.hostname !== '127.0.0.1' || url.pathname.startsWith('/api/')) await route.abort('blockedbyclient')
    else await route.continue()
  })
  await page.goto(`/tests/fixtures/invite-ui.html?scenario=${scenario}`)
  await expect(page.locator('[data-fixture="isolated-invite-controls"]')).toBeVisible()
  await page.getByRole('button', { name: 'Manage', exact: true }).click()
  await page.getByRole('button', { name: 'Onboarding', exact: true }).click()
  return page.getByRole('dialog')
}
async function assertFits(page: Page) {
  const sizes = await page.getByRole('dialog').evaluate((dialog) => ({
    left: dialog.getBoundingClientRect().left, right: dialog.getBoundingClientRect().right,
    top: dialog.getBoundingClientRect().top, bottom: dialog.getBoundingClientRect().bottom,
    width: innerWidth, height: innerHeight, scroll: dialog.scrollWidth, client: dialog.clientWidth,
  }))
  expect(sizes.left).toBeGreaterThanOrEqual(-1)
  expect(sizes.right).toBeLessThanOrEqual(sizes.width + 1)
  expect(sizes.top).toBeGreaterThanOrEqual(-1)
  expect(sizes.bottom).toBeLessThanOrEqual(sizes.height + 1)
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.client + 1)
}

test('pending email and readback prevent repeated taps and competing actions', async ({ page }) => {
  const dialog = await openOnboarding(page, 'pending')
  const login = dialog.getByRole('button', { name: 'Email login instructions', exact: true })
  await login.evaluate((button: HTMLButtonElement) => { button.click(); button.click() })
  await expect.poll(() => page.evaluate(() => window.inviteFixture.snapshot().loginCalls)).toBe(1)
  for (const name of ['Profile', 'Login & Security', 'Onboarding', 'Close dialog', 'Send welcome email']) await expect(dialog.getByRole('button', { name, exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await assertFits(page)
  await page.evaluate(() => window.inviteFixture.releaseLogin())
  await expect.poll(() => page.evaluate(() => window.inviteFixture.snapshot().directoryCalls)).toBe(2)
  await expect(dialog.getByRole('button', { name: 'Close dialog', exact: true })).toBeDisabled()
  await page.evaluate(() => window.inviteFixture.releaseReadback())
  await expect(login).toBeEnabled()
  await expect(dialog.locator('.form-feedback[role="status"]')).toContainText('accepted for delivery')
  await expect(dialog.locator('.user-account-onboarding-summary')).toContainText('Created')
  expect(await page.evaluate(() => window.inviteFixture.snapshot())).toEqual({ loginCalls: 1, welcomeCalls: 0, directoryCalls: 2 })
})

test('safe failure retains request reference, refreshes partial outcome, and does not resend', async ({ page }, testInfo) => {
  const dialog = await openOnboarding(page, 'failure')
  await dialog.getByRole('button', { name: 'Send welcome email', exact: true }).click()
  await expect(dialog.locator('.form-feedback[role="status"]')).toContainText('Welcome email accepted for delivery')
  await dialog.getByRole('button', { name: 'Email login instructions', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText(`Request ${requestId}`)
  await expect(dialog.getByRole('alert')).toContainText('could not be confirmed')
  await expect(dialog.locator('.user-account-onboarding-summary')).toContainText('Created')
  await expect(dialog.locator('.form-feedback[role="status"]')).toContainText('Welcome email accepted for delivery')
  await expect(dialog.getByText(/Login instructions accepted/)).toHaveCount(0)
  await dialog.getByRole('alert').scrollIntoViewIfNeeded()
  await expect(dialog.getByRole('alert')).toBeInViewport()
  await assertFits(page)
  await page.screenshot({ path: testInfo.outputPath('invite-failure.png') })
  expect(await page.evaluate(() => window.inviteFixture.snapshot())).toEqual({ loginCalls: 1, welcomeCalls: 1, directoryCalls: 3 })
})

test('failed readback blocks sends; explicit refresh recovers without sending again', async ({ page }) => {
  const dialog = await openOnboarding(page, 'readback-failure')
  await dialog.getByRole('button', { name: 'Email login instructions', exact: true }).click()
  const refresh = dialog.getByRole('button', { name: 'Refresh account status', exact: true })
  await expect(refresh).toBeVisible()
  for (const name of ['Email login instructions', 'Send welcome email']) await expect(dialog.getByRole('button', { name, exact: true })).toBeDisabled()
  await refresh.click()
  await expect(refresh).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Email login instructions', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => window.inviteFixture.snapshot())).toEqual({ loginCalls: 1, welcomeCalls: 0, directoryCalls: 3 })
  await assertFits(page)
})

test('accepted email is not claimed delivered and old receipt clears on close', async ({ page }, testInfo) => {
  const dialog = await openOnboarding(page, 'success')
  await dialog.getByRole('button', { name: 'Email login instructions', exact: true }).click()
  await expect(dialog.locator('.form-feedback[role="status"]')).toContainText(`accepted for delivery to employee@example.invalid. Request ${requestId}.`)
  await expect(dialog.locator('.form-feedback[role="status"]')).not.toContainText(/delivered|successfully sent/i)
  await expect(dialog.getByRole('button', { name: 'Close dialog', exact: true })).toBeEnabled()
  await dialog.locator('.form-feedback[role="status"]').scrollIntoViewIfNeeded()
  await expect(dialog.locator('.form-feedback[role="status"]')).toBeInViewport()
  await assertFits(page)
  await page.screenshot({ path: testInfo.outputPath('invite-accepted.png') })
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.getByRole('button', { name: 'Manage', exact: true }).click()
  await page.getByRole('button', { name: 'Onboarding', exact: true }).click()
  await expect(dialog.getByRole('status')).toHaveCount(0)
  expect(await page.evaluate(() => window.inviteFixture.snapshot().loginCalls)).toBe(1)
})
