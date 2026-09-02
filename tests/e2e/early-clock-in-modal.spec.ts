import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

async function installModalFixture(page: import('@playwright/test').Page, theme: 'dark' | 'light') {
  await page.locator('#root').evaluate((root, selectedTheme) => {
    document.documentElement.dataset.theme = selectedTheme
    document.documentElement.style.colorScheme = selectedTheme
    root.innerHTML = `
      <main style="min-height:100vh;padding:24px">
        <button id="clock-in-trigger" class="primary-action" type="button">Clock in</button>
        <dialog aria-describedby="early-description" aria-labelledby="early-title" class="modal-dialog modal-dialog--early-clock-in" role="alertdialog">
          <div class="modal-dialog__heading">
            <span aria-hidden="true" class="modal-dialog__heading-icon">◷</span>
            <div class="modal-dialog__heading-copy">
              <span class="modal-dialog__eyebrow">CLOCK-IN UNAVAILABLE</span>
              <h2 id="early-title">Your shift hasn’t started yet</h2>
              <p id="early-description">Your scheduled shift starts in 18 minutes.</p>
            </div>
          </div>
          <div aria-label="Early clock-in restriction details" class="early-clock-in-restriction" tabindex="0">
            <section class="early-clock-in-availability">
              <div><span>Your clock-in window opens at</span><strong>7:55 PM (19:55)</strong></div>
              <span class="early-clock-in-availability__pill">In 13 minutes</span>
              <p>You may clock in up to 5 minutes early. Please return at or after 7:55 PM (19:55).</p>
            </section>
            <ol aria-label="Clock-in timing" class="early-clock-in-timeline">
              <li><span>Current server time</span><strong>7:42 PM (19:42)</strong></li>
              <li><span>Clock-in opens</span><strong>7:55 PM (19:55)</strong></li>
              <li><span>Shift starts</span><strong>8:00 PM (20:00)</strong></li>
            </ol>
            <section class="early-clock-in-shift"><span class="early-clock-in-shift__eyebrow">SCHEDULED SHIFT</span><strong>MG Properties Patrol–Unarmed</strong><p>MPP · Unarmed coverage</p><p>Wednesday, 09/02/2026</p><p>8:00 PM (20:00) – 6:00 AM (06:00)</p></section>
            <p class="early-clock-in-server-note">Timing is based on trusted SygShift server time.</p>
            <div class="early-clock-in-footer-note"><strong>Acknowledging this notice will not clock you in.</strong></div>
          </div>
          <div class="early-clock-in-restriction__actions"><button autofocus class="primary-action" type="button">Acknowledge &amp; close</button></div>
        </dialog>
      </main>`
    const dialog = root.querySelector<HTMLDialogElement>('dialog')
    dialog?.showModal()
    dialog?.querySelector<HTMLElement>('[autofocus]')?.focus({ preventScroll: true })
    if (dialog) dialog.scrollTop = 0
  }, theme)
}

for (const theme of ['light', 'dark'] as const) {
  test(`early clock-in alert dialog is contained and accessible in ${theme} mode`, async ({ page }, testInfo) => {
    await page.goto('/')
    await installModalFixture(page, theme)

    const modal = page.getByRole('alertdialog', { name: 'Your shift hasn’t started yet' })
    await expect(modal).toBeVisible()
    await expect(modal.getByRole('button')).toHaveCount(1)
    const acknowledge = modal.getByRole('button', { name: 'Acknowledge & close' })
    await expect(acknowledge).toBeFocused()
    await expect(acknowledge).toBeVisible()

    const viewport = page.viewportSize()
    const box = await modal.boundingBox()
    expect(viewport).not.toBeNull()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width)
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height)
    const actionBox = await acknowledge.boundingBox()
    expect(actionBox).not.toBeNull()
    expect(actionBox!.y).toBeGreaterThanOrEqual(box!.y)
    expect(actionBox!.y + actionBox!.height).toBeLessThanOrEqual(box!.y + box!.height)
    expect(await modal.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)

    const accessibility = await new AxeBuilder({ page }).include('dialog').analyze()
    expect(accessibility.violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`early-clock-in-${theme}.png`), fullPage: true })
  })
}
