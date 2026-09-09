import { expect, test } from '@playwright/test'

test('signed-out employee password recovery opens as a usable login form', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto('/login')
  await page.getByRole('button', { name: 'Forgot password?' }).click()

  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible()
  await expect(page.getByLabel('Username')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send reset link' })).toBeVisible()
  await expect(page.getByLabel('Password')).toHaveCount(0)
  expect(pageErrors).toEqual([])

  const viewportWidth = page.viewportSize()?.width ?? 0
  const bodyWidth = await page.locator('body').evaluate((body) => body.scrollWidth)
  expect(bodyWidth).toBeLessThanOrEqual(viewportWidth)
})

test('missing password-recovery token renders a visible safe failure instead of a blank page', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto('/password-recovery')

  await expect(page.getByRole('heading', { name: 'This reset link cannot be used.' })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('invalid or has expired')
  await expect(page.getByRole('link', { name: 'Return to sign in' })).toBeVisible()
  await expect(page.getByRole('status')).toHaveCount(0)
  expect((await page.locator('#root').innerText()).trim()).not.toBe('')
  expect(pageErrors).toEqual([])

  const viewportWidth = page.viewportSize()?.width ?? 0
  const bodyWidth = await page.locator('body').evaluate((body) => body.scrollWidth)
  expect(bodyWidth).toBeLessThanOrEqual(viewportWidth)
})
