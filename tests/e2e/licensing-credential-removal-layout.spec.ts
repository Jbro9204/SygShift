import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

for (const colorScheme of ['light', 'dark'] as const) {
  for (const viewport of [
    { label: 'desktop', width: 1440, height: 1000 },
    { label: 'mobile', width: 390, height: 844 },
  ]) {
    test(`credential removal stays clear and contained in ${colorScheme} ${viewport.label}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.emulateMedia({ colorScheme })
      await page.goto('/')
      await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim().length > 0)

      await page.locator('#root').evaluate((root) => {
        const fixture = document.createElement('main')
        fixture.id = 'licensing-credential-removal-fixture'
        fixture.innerHTML = `
          <section class="licensing-profile-page" aria-label="Licensing profile for Jordan Brown">
            <section class="licensing-profile-tab-panel">
              <div class="licensing-profile-tab-panel__heading"><div><h2>Credentials on file</h2><p>Open one record at a time to review or update it.</p></div><strong>2</strong></div>
              <details class="licensing-removed-credentials" open>
                <summary>Removed credentials <span>1</span></summary>
                <div class="licensing-removed-credentials__list">
                  <article>
                    <span aria-hidden="true">▣</span>
                    <div><strong>Denver Security Guard License</strong><span>SG-12345 • Removed 09/15/2026, 10:30 AM by Jordan Brown</span><small>Entered by mistake: duplicate entry • 2 saved documents</small></div>
                    <button class="secondary-button secondary-button--small" type="button">↶ Restore</button>
                  </article>
                </div>
              </details>
            </section>
          </section>
          <dialog class="modal-dialog" aria-labelledby="removal-title" open>
            <div class="modal-dialog__heading"><div><h2 id="removal-title">Remove credential from profile?</h2><p>Jordan Brown • Denver Security Guard License</p></div><button class="modal-close" aria-label="Close dialog" type="button">×</button></div>
            <form class="request-form licensing-credential-removal-form">
              <section class="licensing-credential-removal-summary"><span aria-hidden="true">▣</span><div><strong>Denver Security Guard License</strong><span>SG-12345</span></div></section>
              <div class="modal-warning"><strong>This does not delete the record.</strong><span>It will leave the active profile and eligibility calculations. Documents and history remain saved, and an authorized user can restore it later.</span></div>
              <label class="field-stack"><span>Why are you removing it?</span><select><option>Entered by mistake</option></select></label>
              <label class="field-stack"><span>Additional detail <small>Optional</small></span><textarea rows="3">Duplicate entry from training.</textarea></label>
              <div class="modal-actions"><button class="secondary-button" type="button">Keep credential</button><button class="danger-button" type="submit">Remove from profile</button></div>
            </form>
          </dialog>`
        root.replaceWith(fixture)
      })

      const dialog = page.getByRole('dialog')
      await expect(dialog.getByRole('heading', { name: 'Remove credential from profile?' })).toBeVisible()
      await expect(dialog.getByText('This does not delete the record.')).toBeVisible()
      await expect(dialog.getByRole('button', { name: 'Remove from profile' })).toBeVisible()

      const dialogBox = await dialog.boundingBox()
      expect(dialogBox).not.toBeNull()
      expect(dialogBox!.x).toBeGreaterThanOrEqual(0)
      expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(viewport.width + 1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)

      for (const control of await dialog.locator('button, select, textarea').all()) {
        const box = await control.boundingBox()
        expect(box).not.toBeNull()
        expect(box!.height).toBeGreaterThanOrEqual(38)
      }

      const accessibility = await new AxeBuilder({ page }).include('#licensing-credential-removal-fixture').analyze()
      expect(accessibility.violations).toEqual([])
      await page.screenshot({ path: testInfo.outputPath(`credential-removal-${colorScheme}-${viewport.label}.png`), fullPage: true })
    })
  }
}
