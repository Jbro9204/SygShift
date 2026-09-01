import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

for (const colorScheme of ['light', 'dark'] as const) {
  test(`Protected identity verification is clear and responsive in ${colorScheme} mode`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme })
    await page.goto('/')

    await page.locator('#root').evaluate((root) => {
      root.innerHTML = `
        <main style="max-width: 920px; margin: 24px auto;">
          <dialog class="modal-dialog identity-verification-modal" aria-describedby="identity-description" aria-labelledby="identity-title" open>
            <div class="modal-dialog__heading">
              <div>
                <h2 id="identity-title">Verify your identity</h2>
                <p id="identity-description">Licensing documents contain protected employee information. Confirm your identity to continue; the pending document action will resume automatically.</p>
              </div>
              <button aria-label="Close dialog" class="modal-close" type="button">×</button>
            </div>
            <div class="identity-verification-modal__content">
              <div class="identity-verification-modal__notice"><span aria-hidden="true">✓</span><div><strong>Protected document checkpoint</strong><span>Verification remains valid for 15 minutes. Your selected file and licensing information will remain in place.</span></div></div>
              <section class="identity-verification-method identity-verification-method--primary">
                <span aria-hidden="true" class="identity-verification-method__icon">⌁</span>
                <div><strong>Security key</strong><p>Insert or tap your registered FIDO key, then follow the browser prompt.</p></div>
                <button class="primary-action" type="button">Verify with security key</button>
              </section>
              <form class="identity-verification-method">
                <span aria-hidden="true" class="identity-verification-method__icon">●</span>
                <div><strong>Authenticator app</strong><p>Enter the current six-digit code from your enrolled authenticator app.</p></div>
                <label><span>Six-digit code</span><input autocomplete="one-time-code" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" required /></label>
                <button class="secondary-button" type="submit">Verify authenticator</button>
              </form>
              <div class="modal-actions"><button class="secondary-button" type="button">Cancel</button></div>
            </div>
          </dialog>
        </main>`
    })

    const dialog = page.getByRole('dialog', { name: 'Verify your identity' })
    await expect(dialog.getByRole('button', { name: 'Verify with security key' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Verify authenticator' })).toBeVisible()
    await expect(dialog.getByText('Verification remains valid for 15 minutes.', { exact: false })).toBeVisible()

    const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(desktopOverflow).toBeLessThanOrEqual(1)
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`identity-verification-${colorScheme}-desktop.png`), fullPage: true })

    await page.setViewportSize({ height: 780, width: 390 })
    await expect(dialog).toBeVisible()
    const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(mobileOverflow).toBeLessThanOrEqual(1)
    await page.screenshot({ path: testInfo.outputPath(`identity-verification-${colorScheme}-mobile.png`), fullPage: true })
  })
}
