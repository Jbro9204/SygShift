import { expect, test } from '@playwright/test'

const fixture = 'http://127.0.0.1:4186/tests/fixtures/clock-ui.html'
for (const surface of ['home', 'workspace']) {
  for (const scenario of ['early', 'empty']) {
    test(`${surface}: ${scenario} clock-in opens real forced acknowledgment without a punch`, async ({ page }) => {
      await page.goto(`${fixture}?surface=${surface}&scenario=${scenario}`)
      await page.getByRole('button', { name: 'Clock in', exact: true }).click()
      const dialog = page.getByRole('alertdialog', { name: 'Your shift hasn’t started yet' })
      await expect(dialog).toBeVisible()
      await expect(dialog).toContainText('3:55 PM (15:55) EDT')
      await expect(dialog).toContainText('Acknowledging this notice will not clock you in.')
      await page.keyboard.press('Escape')
      await expect(dialog).toBeVisible()
      await expect(page.locator('#clock-fixture-records')).toHaveText('1 attempts · 0 punches')
      await dialog.getByRole('button', { name: 'Acknowledge & close' }).click()
      await expect(dialog).toHaveCount(0)
      await expect(page.getByText('Notice acknowledged')).toBeVisible()
      await page.getByRole('button', { name: 'Clock in', exact: true }).click()
      await expect(dialog).toBeVisible()
      await expect(page.locator('#clock-fixture-records')).toHaveText('2 attempts · 0 punches')
      const bounds = await dialog.boundingBox()
      expect(bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
      await expect(dialog.getByRole('button', { name: 'Acknowledge & close' })).toBeInViewport()
    })
  }
  test(`${surface}: real clock-in, break, resume and clock-out remain usable`, async ({ page }) => {
    await page.goto(`${fixture}?surface=${surface}&scenario=ready`)
    for (const label of ['Clock in', 'Start break', 'End break', 'Clock out']) {
      await page.getByRole('button', { name: label, exact: true }).click()
    }
    await expect(page.locator('#clock-fixture-records')).toHaveText('4 attempts · 4 punches')
    await expect(page.getByRole('button', { name: 'Clock in', exact: true })).toBeEnabled()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
  })
  test(`${surface}: dashboard failure is visible and recoverable, not a false off-clock punch`, async ({ page }) => {
    await page.goto(`${fixture}?surface=${surface}&scenario=error`)
    await expect(page.getByRole('button', { name: 'Clock in', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Retry clock status' }).click()
    await expect(page.getByRole('button', { name: 'Clock in', exact: true })).toBeEnabled()
    await expect(page.locator('#clock-fixture-records')).toHaveText('0 attempts · 0 punches')
  })
  test(`${surface}: no assignment shows accurate guidance without inventing an early shift`, async ({ page }) => {
    await page.goto(`${fixture}?surface=${surface}&scenario=no-assignment`)
    await page.getByRole('button', { name: 'Clock in', exact: true }).click()
    await expect(page.getByText('No active published shift is assigned for clock-in.', { exact: false })).toBeVisible()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(page.locator('#clock-fixture-records')).toHaveText('1 attempts · 0 punches')
  })
}
for (const role of ['guard', 'admin', 'dispatcher', 'supervisor']) {
  test(`Home preserves active clock-out and break controls for ${role}, even without shift metadata`, async ({ page }) => {
    await page.goto(`${fixture}?scenario=working&role=${role}`)
    await expect(page.getByRole('button', { name: 'Clock out', exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Start break', exact: true })).toBeEnabled()
    await page.getByRole('link', { name: 'My Time', exact: true }).first().click()
    await expect(page.getByRole('button', { name: 'Clock out', exact: true })).toBeEnabled()
  })
}
test('Home offers selection instead of silently punching an ambiguous shift', async ({ page }) => {
  await page.goto(`${fixture}?scenario=multiple`)
  await page.getByRole('link', { name: 'Choose shift' }).click()
  await expect(page.getByRole('combobox', { name: 'Shift for clock in' })).toBeVisible()
  await expect(page.locator('#clock-fixture-records')).toHaveText('0 attempts · 0 punches')
})
test('Read-only time access does not gain punch permission', async ({ page }) => {
  await page.goto(`${fixture}?scenario=working&viewonly`)
  await expect(page.getByRole('region', { name: 'Current time status' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Clock out', exact: true })).toHaveCount(0)
  await page.getByRole('link', { name: 'My Time', exact: true }).first().click()
  await expect(page.getByRole('button', { name: 'Clock out', exact: true })).toBeDisabled()
})

for (const theme of ['light', 'dark']) {
  test(`Early warning remains readable in ${theme} mode`, async ({ page }, testInfo) => {
    await page.goto(`${fixture}?theme=${theme}`)
    await page.getByRole('button', { name: 'Clock in', exact: true }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Acknowledge & close' })).toBeInViewport()
    await page.screenshot({ path: testInfo.outputPath(`early-warning-${theme}.png`) })
  })
}

test('Home prevents rapid duplicate submissions and keeps My Time in sync', async ({ page }) => {
  await page.goto(`${fixture}?scenario=ready`)
  await page.getByRole('button', { name: 'Clock in', exact: true }).dblclick()
  await expect(page.getByRole('button', { name: 'Clock out', exact: true })).toBeEnabled()
  await page.getByRole('link', { name: 'My Time', exact: true }).first().click()
  await expect(page.getByRole('button', { name: 'Clock out', exact: true })).toBeEnabled()
  await expect(page.locator('#clock-fixture-records')).toHaveText('1 attempts · 1 punches')
})
