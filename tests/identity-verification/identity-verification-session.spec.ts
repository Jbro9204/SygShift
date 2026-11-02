import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.route('https://**/*', (route) => route.abort())
  await page.goto('/tests/fixtures/identity-verification-ui.html')
  await expect(page.getByRole('heading', { name: 'Identity verification regression fixture' })).toBeVisible()
})

test('Guard ordinary read and authority denial never open an MFA checkpoint', async ({ page }, testInfo) => {
  await page.getByRole('button', { name: 'Switch to Guard', exact: true }).click()
  await page.getByRole('button', { name: 'Read my schedule', exact: true }).click()
  await expect(page.getByLabel('Request result')).toHaveText('HTTP 200')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: 'Permission denied action', exact: true }).click()
  await expect(page.getByLabel('Request result')).toHaveText('HTTP 403')
  await expect(page.getByLabel('Request attempts')).toHaveText('1')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('guard-no-unnecessary-mfa.png'), fullPage: true })
})

test('genuine protected action verifies once and survives same-session token refresh', async ({ page }, testInfo) => {
  await page.getByRole('button', { name: 'Protected action', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Verify your identity' })
  await expect(dialog).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('protected-mfa-checkpoint.png'), fullPage: true })
  await page.getByRole('button', { name: 'Refresh same session', exact: true }).evaluate((button: HTMLButtonElement) => button.click())
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Six-digit code').fill('123456')
  await dialog.getByRole('button', { name: 'Verify authenticator', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByLabel('Request result')).toHaveText('HTTP 200')
  await expect(page.getByLabel('Request attempts')).toHaveText('2')
})

for (const action of ['Switch to Guard', 'Sign out', 'Navigate to Schedule']) {
  test(`pending checkpoint cancels without replay after ${action}`, async ({ page }) => {
    await page.getByRole('button', { name: 'Protected action', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    // Programmatic click simulates an external auth/navigation event while a modal owns focus.
    await page.getByRole('button', { name: action, exact: true }).evaluate((button: HTMLButtonElement) => button.click())
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByLabel('Request result')).toHaveText('HTTP 403')
    await expect(page.getByLabel('Request attempts')).toHaveText('1')
  })
  test(`late protected response does not prompt or replay after ${action}`, async ({ page }) => {
    await page.getByRole('button', { name: 'Start delayed protected response', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Release delayed response', exact: true })).toBeVisible()
    await page.getByRole('button', { name: action, exact: true }).click()
    await page.getByRole('button', { name: 'Release delayed response', exact: true }).click()
    await expect(page.getByLabel('Request result')).toHaveText('HTTP 403')
    await expect(page.getByLabel('Request attempts')).toHaveText('1')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
}
