import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('overview is readable and has no automatically detectable accessibility violations', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'One clear view of the day.' })).toBeVisible()
  await expect(page.getByText('No schedule has been published.')).toBeVisible()

  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])
})

test('master schedule remains usable on the configured viewport', async ({ page }) => {
  await page.goto('/schedule')

  await expect(page.getByRole('heading', { name: 'Master schedule' })).toBeVisible()
  await expect(page.getByRole('table', { name: 'Weekly master schedule' })).toBeVisible()

  const bodyWidth = await page.locator('body').evaluate((body) => body.scrollWidth)
  const viewportWidth = page.viewportSize()?.width ?? 0
  expect(bodyWidth).toBeLessThanOrEqual(viewportWidth)
})

test('employee directory protects source data and remains accessible', async ({ page }) => {
  await page.goto('/people')

  await expect(page.getByRole('heading', { name: 'Employee directory' })).toBeVisible()
  await expect(page.getByText('Directory ready for the secure connection')).toBeVisible()
  await expect(page.getByText('Sensitive details require supervisor access and MFA')).toBeVisible()

  const bodyWidth = await page.locator('body').evaluate((body) => body.scrollWidth)
  const viewportWidth = page.viewportSize()?.width ?? 0
  expect(bodyWidth).toBeLessThanOrEqual(viewportWidth)

  const navigation = page.getByRole('navigation', { name: 'Primary navigation' })
  if (viewportWidth < 900) {
    await expect(navigation).toBeHidden()
    await page.getByRole('button', { name: 'Open navigation' }).click()
    await expect(navigation).toBeVisible()
    await page.getByRole('button', { name: 'Close navigation' }).click()
    await expect(navigation).toBeHidden()
  } else {
    await expect(navigation).toBeVisible()
  }

  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])
})

test('site registry explains review safeguards without fabricated locations', async ({ page }) => {
  await page.goto('/sites')

  await expect(page.getByRole('heading', { name: 'Sites & posts' })).toBeVisible()
  await expect(page.getByText('Site registry ready for reviewed data')).toBeVisible()
  await expect(page.getByText('No site will be silently merged or guessed.')).toBeVisible()

  const bodyWidth = await page.locator('body').evaluate((body) => body.scrollWidth)
  const viewportWidth = page.viewportSize()?.width ?? 0
  expect(bodyWidth).toBeLessThanOrEqual(viewportWidth)

  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])
})
