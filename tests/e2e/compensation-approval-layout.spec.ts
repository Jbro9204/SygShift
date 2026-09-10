import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('compensation worklist review remains clear and contained', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim().length > 0)
  await page.locator('#root').evaluate((root) => {
    const fixtureRoot = root.cloneNode(false) as HTMLElement
    root.replaceWith(fixtureRoot)
    fixtureRoot.innerHTML = `
      <main class="page page--hr-automation" style="max-width:1180px;margin:24px auto">
        <section class="page-intro workforce-intro">
          <div><p class="eyebrow">HR &amp; Finance</p><h1>Compensation</h1><p class="page-summary">Review protected compensation records and controlled proposals.</p></div>
          <button class="secondary-button" type="button">Refresh</button>
        </section>
        <section class="hr-stage-grid">
          <article class="panel hr-automation-worklist">
            <div class="section-heading"><div><p class="eyebrow">Approval worklist</p><h2>Compensation proposals</h2></div></div>
            <div class="hr-automation-list">
              <article>
                <div><strong>William Lane</strong><span>SYG-1029 · Base pay · effective 08/08/2026</span></div>
                <div class="hr-compensation-row__controls"><div><strong>$26.00</strong><small>hourly</small></div><button class="secondary-button" type="button">Review</button></div>
              </article>
            </div>
          </article>
          <article class="panel hr-automation-worklist">
            <div class="section-heading"><div><p class="eyebrow">Configuration</p><h2>Pay components</h2></div></div>
          </article>
        </section>
      </main>
      <dialog class="modal-dialog hr-file-editor-modal" open aria-labelledby="compensation-dialog-title" aria-describedby="compensation-dialog-description">
        <div class="modal-dialog__heading">
          <div class="modal-dialog__heading-copy"><h2 id="compensation-dialog-title">Review pay rate · William Lane</h2><p id="compensation-dialog-description">Review the proposed amount, effective date, and documented reason before recording an irreversible approval decision.</p></div>
          <button aria-label="Close dialog" class="modal-close" type="button">×</button>
        </div>
        <form>
          <div class="hr-pay-rate-review-summary"><span>Proposed rate<strong>$26.00 per hour</strong></span><span>Effective<strong>08/08/2026</strong></span><span>Proposed by<strong>HR Manager</strong></span><p>Approved market adjustment.</p></div>
          <div class="hr-pay-rate-decision" role="group" aria-label="Pay-rate decision"><button class="is-active" type="button">Approve</button><button type="button">Reject</button></div>
          <label>Review reason<textarea required rows="4">Verified against the signed compensation authorization.</textarea></label>
          <div class="modal-actions"><button class="secondary-button" type="button">Cancel</button><button class="primary-action" type="submit">Record approval</button></div>
        </form>
      </dialog>`
  })

  const review = page.getByRole('button', { name: 'Review' })
  const dialog = page.getByRole('dialog', { name: 'Review pay rate · William Lane' })
  await expect(review).toBeVisible()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Approved market adjustment.')).toBeVisible()

  const dialogBox = (await dialog.boundingBox())!
  const viewport = page.viewportSize()!
  expect(dialogBox.x).toBeGreaterThanOrEqual(4)
  expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(viewport.width - 4)
  for (const control of await dialog.locator('button, textarea').all()) {
    const box = (await control.boundingBox())!
    expect(box.height).toBeGreaterThanOrEqual(42)
    expect(box.x).toBeGreaterThanOrEqual(dialogBox.x)
    expect(box.x + box.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width + 1)
  }
  expect((await review.boundingBox())!.height).toBeGreaterThanOrEqual(42)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('compensation-approval-layout.png'), fullPage: true })

  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
    document.documentElement.style.colorScheme = 'dark'
  })
  await expect(dialog.getByText('Approved market adjustment.')).toBeVisible()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('compensation-approval-layout-dark.png'), fullPage: true })
})
