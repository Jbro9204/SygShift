import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('overview is readable and has no automatically detectable accessibility violations', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'One clear view of the day.' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'What needs attention' })).toBeVisible()
  await expect(page.getByText('Schedule data is not connected yet.')).toBeVisible()

  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])
})

test('master schedule remains usable on the configured viewport', async ({ page }) => {
  await page.goto('/schedule')

  await expect(page.getByRole('heading', { name: 'Master schedule' })).toBeVisible()
  await expect(page.getByRole('table', { name: 'Weekly master schedule' })).toBeVisible()
  await expect(page.getByText('Schedule ready for the secure connection.')).toBeVisible()

  const bodyWidth = await page.locator('body').evaluate((body) => body.scrollWidth)
  const viewportWidth = page.viewportSize()?.width ?? 0
  expect(bodyWidth).toBeLessThanOrEqual(viewportWidth)

  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])
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

test('events and openings explain the guarded request workflow', async ({ page }) => {
  await page.goto('/events')

  await expect(page.getByRole('heading', { name: 'Events & openings' })).toBeVisible()
  await expect(page.getByText('Openings ready for the secure connection')).toBeVisible()
  await expect(page.getByText('Armed work is never shown to an unqualified guard.')).toBeVisible()

  const bodyWidth = await page.locator('body').evaluate((body) => body.scrollWidth)
  const viewportWidth = page.viewportSize()?.width ?? 0
  expect(bodyWidth).toBeLessThanOrEqual(viewportWidth)

  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])
})

test('announcements explain the controlled template workflow', async ({ page }) => {
  await page.goto('/announcements')

  await expect(page.getByRole('heading', { name: 'Announcements' })).toBeVisible()
  await expect(page.getByText('Announcement templates need the secure connection')).toBeVisible()
  await expect(page.getByText('Approved templates, recipient counts, and send history')).toBeVisible()

  const bodyWidth = await page.locator('body').evaluate((body) => body.scrollWidth)
  const viewportWidth = page.viewportSize()?.width ?? 0
  expect(bodyWidth).toBeLessThanOrEqual(viewportWidth)

  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])
})

test('request center explains protected guard and supervisor workflows', async ({ page }) => {
  await page.goto('/requests')

  await expect(page.getByRole('heading', { name: 'Requests & call-offs' })).toBeVisible()
  await expect(page.getByText('Request workflows ready for the secure connection')).toBeVisible()
  await expect(page.getByText('Supervisor approvals protected by MFA')).toBeVisible()

  const bodyWidth = await page.locator('body').evaluate((body) => body.scrollWidth)
  const viewportWidth = page.viewportSize()?.width ?? 0
  expect(bodyWidth).toBeLessThanOrEqual(viewportWidth)

  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])
})

test('workbook import review presents verified staging without exposing private records', async ({ page }) => {
  await page.goto('/import-review')

  await expect(page.getByRole('heading', { name: 'Workbook import review' })).toBeVisible()
  await expect(page.getByText('Every workbook cell is preserved and traceable.')).toBeVisible()
  await expect(page.getByText('Ready for the secure Supabase connection')).toBeVisible()
  await expect(page.getByText('110,274')).toBeVisible()
  await expect(page.getByText('9,408')).toBeVisible()

  const bodyWidth = await page.locator('body').evaluate((body) => body.scrollWidth)
  const viewportWidth = page.viewportSize()?.width ?? 0
  expect(bodyWidth).toBeLessThanOrEqual(viewportWidth)

  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])
})

test('operational import explains the guarded current-schedule mapping process', async ({ page }) => {
  await page.goto('/operational-import')

  await expect(page.getByRole('heading', { name: 'Operational import' })).toBeVisible()
  await expect(page.getByText('The current schedule is reduced to a manageable review.')).toBeVisible()
  await expect(page.getByText('Ready to connect the protected mapping workspace')).toBeVisible()

  const bodyWidth = await page.locator('body').evaluate((body) => body.scrollWidth)
  const viewportWidth = page.viewportSize()?.width ?? 0
  expect(bodyWidth).toBeLessThanOrEqual(viewportWidth)

  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])
})
