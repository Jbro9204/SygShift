import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('Employee Lifecycle is guided, contained, and unmistakable', async ({ page }, testInfo) => {
  await page.goto('/')

  await page.locator('#root').evaluate((root) => {
    const fixtureRoot = root.cloneNode(false) as HTMLElement
    root.replaceWith(fixtureRoot)
    fixtureRoot.innerHTML = `
      <dialog class="modal-dialog hr-lifecycle-case-modal" open aria-labelledby="lifecycle-title">
        <div class="modal-dialog__heading"><div><p class="eyebrow">EMPLOYEE LIFECYCLE</p><h2 id="lifecycle-title">Sample Employee · Involuntary termination</h2><p>One protected timeline for approval, handoffs, documents, and final execution.</p></div><button class="modal-close" aria-label="Close dialog" type="button">×</button></div>
        <div class="hr-lifecycle-case">
          <ol aria-label="Lifecycle progress" class="hr-lifecycle-case__progress">
            <li class="is-complete"><span>✓</span>Request</li><li class="is-complete"><span>✓</span>Approval</li><li><span></span>Checklist</li><li><span></span>Final action</li>
          </ol>
          <section class="hr-lifecycle-case__summary"><div><span class="action-status">In progress</span><h3>Sample Employee</h3><p>@sampleemployee · Guard</p></div><dl><div><dt>Effective date</dt><dd>09/12/2026</dd></div><div><dt>Opened by</dt><dd>HR Manager</dd></div><div><dt>Approval</dt><dd>Admin Reviewer</dd></div><div><dt>Checklist</dt><dd>2 of 12 complete or waived</dd></div></dl><p class="hr-lifecycle-case__reason"><strong>Protected business reason</strong>Approved employment separation after required review.</p></section>
          <section class="hr-lifecycle-case__conditions"><div><p class="eyebrow">LIVE READINESS CHECKS</p><h3>Records that need attention</h3></div><div><span><strong>2</strong>Future assignments</span><span><strong>1</strong>Pending time correction</span><span><strong>3</strong>Assigned assets</span></div><small>These are live references—not copied records.</small></section>
          <section class="hr-lifecycle-case__checklist"><div class="section-heading"><div><p class="eyebrow">REQUIRED HANDOFFS</p><h3>Offboarding checklist</h3></div><span>2/12</span></div><div class="hr-lifecycle-task-list"><article><div class="hr-lifecycle-task-list__icon">✓</div><div><strong>Final timecard review</strong><span>Payroll Owner · due 09/12/2026</span></div><span class="action-status">Ready</span><button class="secondary-button secondary-button--small" type="button">Update</button></article><article><div class="hr-lifecycle-task-list__icon">✓</div><div><strong>Property and equipment return</strong><span>HR Owner · due 09/12/2026</span></div><span class="action-status">In progress</span><button class="secondary-button secondary-button--small" type="button">Update</button></article></div></section>
          <section class="hr-lifecycle-case__final"><div><span><strong>Final human-confirmed action</strong><small>Available only after all checklist items are complete or waived.</small></span><button class="danger-action" disabled type="button">Complete separation</button></div><form><label for="execution-reason">Final execution reason</label><textarea id="execution-reason">Approved after investigation and final review.</textarea><label for="confirmation-username">Confirm employee username</label><input id="confirmation-username" value="sampleemployee"></form></section>
          <details class="hr-lifecycle-case__history"><summary>Permanent case timeline <span>3</span></summary></details>
        </div>
      </dialog>`
  })

  const dialog = page.getByRole('dialog')
  const dialogBox = await dialog.boundingBox()
  const viewport = page.viewportSize()
  expect(dialogBox).not.toBeNull()
  expect(viewport).not.toBeNull()
  expect(dialogBox!.x).toBeGreaterThanOrEqual(4)
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(viewport!.width - 4)

  for (const control of await dialog.locator('button').all()) {
    const box = await control.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.height).toBeGreaterThanOrEqual(38)
  }

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await expect(dialog.getByText('Final human-confirmed action')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Complete separation' })).toBeDisabled()
  for (const control of [dialog.getByLabel('Final execution reason'), dialog.getByLabel('Confirm employee username')]) {
    const typography = await control.evaluate((element) => {
      const style = window.getComputedStyle(element)
      return { fontFamily: style.fontFamily, fontSize: style.fontSize }
    })
    expect(typography.fontSize).toBe('16px')
    expect(typography.fontFamily).not.toMatch(/monospace|consolas|courier/i)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: testInfo.outputPath('hr-lifecycle-case.png'), fullPage: true })
})

for (const theme of ['light', 'dark']) {
  test(`User Accounts uses one actual searchable role list in ${theme} mode`, async ({ page }, testInfo) => {
    await page.goto(`http://127.0.0.1:${4189 + Number(process.env.PLAYWRIGHT_PORT_OFFSET ?? 0)}/tests/fixtures/roles-ui.html?theme=${theme}`)
    await expect(page.getByRole('group', { name: 'Roles', exact: true })).toHaveCount(1)
    await expect(page.getByText('Workforce role')).toHaveCount(0)
    await expect(page.getByText('Add specialized access')).toHaveCount(0)
    await expect(page.getByText('2 roles assigned')).toBeVisible()
    await expect(page.getByRole('group', { name: 'Available roles' })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath(`user-accounts-roles-collapsed-${theme}.png`), fullPage: true })
    await page.getByRole('button', { name: 'Manage roles' }).click()
    const searchBox = page.getByRole('searchbox', { name: 'Search roles' })
    const searchMetrics = await searchBox.evaluate((element) => {
      const input = element as HTMLInputElement
      const icon = input.parentElement?.querySelector('svg')
      const inputBox = input.getBoundingClientRect()
      const iconBox = icon?.getBoundingClientRect()
      return {
        borderRadius: Number.parseFloat(getComputedStyle(input).borderRadius),
        iconRight: iconBox?.right ?? inputBox.left,
        paddingLeft: Number.parseFloat(getComputedStyle(input).paddingLeft),
        textStart: inputBox.left + Number.parseFloat(getComputedStyle(input).paddingLeft),
      }
    })
    expect(searchMetrics.borderRadius).toBeGreaterThanOrEqual(10)
    expect(searchMetrics.paddingLeft).toBeGreaterThanOrEqual(44)
    expect(searchMetrics.textStart - searchMetrics.iconRight).toBeGreaterThanOrEqual(8)
    await expect(page.getByRole('checkbox', { name: 'Supervisor', exact: true })).toBeChecked()
    await expect(page.getByRole('checkbox', { name: 'Human Resources Manager', exact: true })).toBeChecked()
    await expect(page.getByText('Handles employee records, onboarding, HR documents, leave, and employee support.')).toBeVisible()
    await expect(page.getByText(/Protected ordinary HR employee-lifecycle authority/)).toHaveCount(0)
    const columns = await page.getByRole('group', { name: 'Available roles' }).evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)
    expect(columns).toBe(testInfo.project.name.startsWith('mobile') ? 1 : 2)
    for (const roleCard of await page.locator('.employee-roles__row').all()) {
      const cardBox = await roleCard.boundingBox()
      const badges = roleCard.locator('.employee-roles__badges')
      if (await badges.count()) {
        const badgeBox = await badges.boundingBox()
        expect(cardBox).not.toBeNull()
        expect(badgeBox).not.toBeNull()
        expect(cardBox!.y + cardBox!.height - (badgeBox!.y + badgeBox!.height)).toBeGreaterThanOrEqual(14)
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: testInfo.outputPath(`user-accounts-role-library-${theme}.png`), fullPage: true })
    await page.getByRole('button', { name: 'Collapse roles' }).click()
    await expect(page.getByRole('group', { name: 'Available roles' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Manage roles' }).click()
    await page.getByRole('searchbox', { name: 'Search roles' }).fill('operations')
    await expect(page.getByRole('checkbox', { name: 'Operations Manager', exact: true })).toBeVisible()
    await page.getByRole('checkbox', { name: 'Operations Manager', exact: true }).check()
    await page.getByRole('button', { name: 'Save employee', exact: true }).click()
    const review = page.getByRole('dialog', { name: 'Review role changes' })
    await expect(review).toBeVisible()
    await expect(review).toContainText('Operations Manager · MFA required')
    await expect(review.getByRole('button', { name: 'Confirm & save employee' })).toBeInViewport()
    await review.getByRole('button', { name: 'Confirm & save employee' }).click()
    await expect(page.getByLabel('Saved role result')).toContainText('ops-role')
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`user-accounts-role-assignment-${theme}.png`), fullPage: true })
  })
}
