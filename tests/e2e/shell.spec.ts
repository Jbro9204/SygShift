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
