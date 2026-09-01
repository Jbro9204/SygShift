import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('Employee File editors and urgent actions remain polished on desktop and mobile', async ({ page }, testInfo) => {
  await page.goto('/')

  await page.locator('#root').evaluate((root) => {
    root.innerHTML = `
      <main class="page hr-employee-file" aria-label="Employee File visual fixture">
        <section class="hr-file-card">
          <div class="hr-file-card__heading">
            <div><p class="eyebrow">EMPLOYEE FILE</p><h2>Employment profile</h2></div>
            <button class="hr-file-card__edit" type="button">Edit employment</button>
          </div>
          <div class="hr-file-detail-grid">
            <article><span>Job title</span><strong>Patrol Supervisor</strong></article>
            <article><span>Work classification</span><strong>Full Time</strong></article>
            <article><span>Pay &amp; timekeeping type</span><strong>Hourly</strong></article>
          </div>
        </section>

        <section class="hr-file-compensation" aria-labelledby="pay-heading">
          <div class="hr-file-card__heading">
            <div><p class="eyebrow">HIGHLY RESTRICTED</p><h2 id="pay-heading">Compensation &amp; pay rate</h2></div>
            <button class="hr-file-card__edit" type="button">Propose rate change</button>
          </div>
          <div class="hr-file-compensation__summary">
            <article><span>Current base pay</span><strong>$28.00 per hour</strong><small>Effective 09/01/2026</small></article>
            <article><span>Pending approval</span><strong>0</strong><small>A different authorized administrator approves changes.</small></article>
          </div>
        </section>

        <section class="home-time-strip" aria-label="Urgent action examples">
          <div class="home-time-strip__actions">
            <button class="danger-button urgent-action-button urgent-action-button--compact" type="button">Clock out</button>
          </div>
          <div class="home-quick-actions__buttons">
            <a class="home-quick-action home-quick-action--danger urgent-action-button" href="#call-off"><span><strong>Report sick / call-off</strong><small>Notify Dispatch and request coverage.</small></span></a>
          </div>
        </section>
      </main>

      <dialog class="modal-dialog hr-file-editor-modal hr-file-editor-modal--wide" open aria-labelledby="contact-modal-title">
        <div class="modal-dialog__heading">
          <div><h2 id="contact-modal-title">Contact &amp; emergency details</h2><p>Update protected contact information in one place.</p></div>
          <button class="modal-close" aria-label="Close dialog" type="button">×</button>
        </div>
        <form>
          <div class="hr-file-editor-notice"><div><strong>Restricted HR information</strong><p>Exact permission and MFA are required.</p></div></div>
          <section class="hr-file-editor-section hr-file-editor-section--emergency">
            <div><h3>Emergency contact</h3><p>Who should be contacted in an emergency?</p></div>
            <div class="hr-file-editor-grid">
              <label>Full name<input value="Emergency Contact" /></label>
              <label>Relationship<input value="Parent" /></label>
              <label>Phone<input value="(555) 555-0100" /></label>
              <label>Email<input value="contact@example.com" /></label>
            </div>
          </section>
          <label>Reason for change<textarea required rows="3">Employee supplied updated emergency details.</textarea></label>
          <div class="modal-actions"><button class="secondary-button" type="button">Cancel</button><button class="primary-action" type="button">Save contact details</button></div>
        </form>
      </dialog>`
  })

  const dialog = page.getByRole('dialog')
  const dialogBox = await dialog.boundingBox()
  const viewport = page.viewportSize()
  expect(dialogBox).not.toBeNull()
  expect(viewport).not.toBeNull()
  expect(dialogBox!.x).toBeGreaterThanOrEqual(4)
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(viewport!.width - 4)

  for (const control of await dialog.locator('button, input, textarea').all()) {
    const box = await control.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.height).toBeGreaterThanOrEqual(42)
    expect(box!.x).toBeGreaterThanOrEqual(dialogBox!.x)
    expect(box!.x + box!.width).toBeLessThanOrEqual(dialogBox!.x + dialogBox!.width + 1)
  }

  const urgentButtons = page.locator('.urgent-action-button')
  await expect(urgentButtons).toHaveCount(2)
  for (const button of await urgentButtons.all()) {
    const visual = await button.evaluate((element) => {
      const styles = getComputedStyle(element)
      return {
        borderRadius: Number.parseFloat(styles.borderRadius),
        boxShadow: styles.boxShadow,
        color: styles.color,
      }
    })
    expect(visual.borderRadius).toBeGreaterThanOrEqual(10)
    expect(visual.boxShadow).not.toBe('none')
    expect(visual.color).toBe('rgb(255, 255, 255)')
  }

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)
  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])

  await page.screenshot({ path: testInfo.outputPath('employee-file-editing-layout.png'), fullPage: true })
})
