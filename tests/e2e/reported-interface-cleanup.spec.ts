import { expect, test } from '@playwright/test'

test('reported schedule, modal, reporting, payroll, and administration layouts remain readable', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim().length > 0)
  await page.locator('#root').evaluate((root) => {
    root.innerHTML = `
      <main style="display:grid;gap:22px;max-width:1180px;margin:24px auto;padding:0 16px">
        <section aria-label="Dispatch fixture" style="width:156px">
          <article class="shift-card">
            <div class="shift-card__heading shift-card__heading--dispatch"><strong>6:00 PM (18:00) – 10:00 PM (22:00)</strong><span class="shift-tag shift-tag--dispatch">Dispatch phone duty</span></div>
            <span class="shift-card__title">Dispatch phone coverage</span>
            <div class="shift-card__people"><span>Jordan Brown</span></div>
          </article>
        </section>

        <section class="panel action-report" aria-label="Compliance completion report">
          <div class="section-heading"><div><p class="eyebrow">Compliance</p><h2>Completion reporting</h2></div><button class="secondary-button" type="button">Export training</button></div>
          <div class="action-report-grid"><article><span>Announcement records</span><strong>12</strong></article><article><span>Training records</span><strong>8</strong></article><article><span>Schedule records</span><strong>19</strong></article></div>
        </section>

        <section class="time-command-grid time-command-grid--exception-summary" aria-label="Exception summary">
          ${['Blocked Rows', 'Pending Requests', 'Unscheduled', 'Missed Clock-Ins'].map((label, index) => `<article class="time-card time-metric"><span>${label}</span><strong>${index + 1}</strong></article>`).join('')}
        </section>

        <section class="time-card payroll-period-controls" aria-label="Payroll period controls"><div class="payroll-period-controls__actions">
          <button class="time-button time-button--secondary" aria-pressed="false" type="button"><span>Last completed pay period</span></button>
          <button class="time-button time-button--primary" aria-pressed="true" type="button"><span>Current open period</span></button>
        </div></section>

        <section class="administration-access-grid" aria-label="User and role administration">
          <a class="administration-access-card" href="#users"><span aria-hidden="true">◎</span><span><strong>User Accounts</strong><small>Employee logins, account status, onboarding, MFA, and recovery.</small></span><span aria-hidden="true">→</span></a>
          <a class="administration-access-card" href="#roles"><span aria-hidden="true">◇</span><span><strong>Roles &amp; Permissions</strong><small>Role definitions, permissions, memberships, and individual access.</small></span><span aria-hidden="true">→</span></a>
        </section>

        <section class="modal-dialog client-document-upload-modal" aria-label="Upload client document fixture">
          <div class="modal-dialog__heading"><div><h2>Upload client document</h2><p>Files remain in a private vault.</p></div></div>
          <form class="client-form"><label><span>Title</span><input value="Service agreement" /></label><label><span>Description</span><textarea rows="3">Approved client record.</textarea></label><div class="modal-actions"><button class="secondary-button" type="button">Cancel</button><button class="primary-action" type="button">Upload securely</button></div></form>
        </section>
      </main>`
  })

  const dispatch = page.locator('.shift-card__heading--dispatch')
  await expect(dispatch.locator('strong')).toHaveCSS('word-break', 'normal')
  expect(await dispatch.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)

  const report = page.locator('.action-report')
  await expect(report).toHaveCSS('min-height', '0px')

  const viewport = page.viewportSize()!
  if (viewport.width > 720) expect((await report.boundingBox())!.height).toBeLessThan(290)
  const summaryColumns = await page.locator('.time-command-grid--exception-summary').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)
  expect(summaryColumns).toBe(viewport.width > 1100 ? 4 : viewport.width > 720 ? 2 : 1)

  const selectedPeriod = page.getByRole('button', { name: 'Current open period' })
  await expect(selectedPeriod).toHaveAttribute('aria-pressed', 'true')
  await expect(selectedPeriod).toHaveCSS('color', 'rgb(31, 23, 9)')

  const dialog = page.locator('.client-document-upload-modal')
  const form = dialog.locator('form')
  const dialogBox = (await dialog.boundingBox())!
  const formBox = (await form.boundingBox())!
  expect(formBox.x - dialogBox.x).toBeGreaterThanOrEqual(15)
  expect(dialogBox.x + dialogBox.width - (formBox.x + formBox.width)).toBeGreaterThanOrEqual(15)

  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: testInfo.outputPath('reported-interface-cleanup.png'), fullPage: true })
})
