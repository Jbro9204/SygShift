import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const protectedRoutes = [
  '/',
  '/schedule',
  '/people',
  '/sites',
  '/events',
  '/announcements',
  '/requests',
  '/access-control',
  '/time',
  '/time/my-time',
  '/time/team',
  '/time/review',
  '/time/operations',
  '/time/accountability',
]

test('signed-out workspace is readable, contained, and accessible', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Sign in to your schedule workspace.' })).toBeVisible()
  await expect(page.getByLabel('Username')).toBeVisible()
  await expect(page.locator('#login-password')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()

  const viewportWidth = page.viewportSize()?.width ?? 0
  const bodyWidth = await page.locator('body').evaluate((body) => body.scrollWidth)
  expect(bodyWidth).toBeLessThanOrEqual(viewportWidth)

  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])
})

test('password visibility control works without submitting the form', async ({ page }) => {
  await page.goto('/login')

  const password = page.locator('#login-password')
  await expect(password).toHaveAttribute('type', 'password')
  await page.getByRole('button', { name: 'Show password' }).click()
  await expect(password).toHaveAttribute('type', 'text')
  await page.getByRole('button', { name: 'Hide password' }).click()
  await expect(password).toHaveAttribute('type', 'password')
  await expect(page).toHaveURL(/\/login$/)
})

test('protected workflows do not render without an authenticated session', async ({ page }) => {
  for (const route of protectedRoutes) {
    await page.goto(route)
    await expect(page.getByRole('heading', { name: 'Sign in to your schedule workspace.' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toHaveCount(0)
  }
})
