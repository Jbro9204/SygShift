import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

for (const colorScheme of ['light', 'dark'] as const) {
  test(`Licensing documents remain compact and readable in ${colorScheme} mode`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme })
    await page.goto('/')

    await page.locator('#root').evaluate((root) => {
      const documents = [
        ['Denver-guard-license.pdf', '1.2 MB · Uploaded 09/01/2026, 3:05 PM'],
        ['Armed-endorsement-front.png', '846 KB · Uploaded 08/28/2026, 11:24 AM'],
        ['Armed-endorsement-back.png', '790 KB · Uploaded 08/28/2026, 11:24 AM'],
        ['Renewal-confirmation.pdf', '328 KB · Uploaded 07/12/2026, 9:03 AM'],
        ['Training-certificate.pdf', '544 KB · Uploaded 06/18/2026, 2:17 PM'],
      ]
      root.innerHTML = `
        <main style="max-width: 1120px; margin: 24px auto;">
          <dialog class="modal-dialog modal-dialog--wide" aria-labelledby="document-title" open>
            <div class="modal-dialog__heading">
              <div><h2 id="document-title">Manage credential/license</h2><p>Jason Douglass · Denver Security Guard License</p></div>
              <button class="modal-close" aria-label="Close dialog" type="button">×</button>
            </div>
            <section class="licensing-document-panel">
              <div class="licensing-document-panel__heading">
                <div><strong>Credential documents</strong><span>PDF, PNG, JPEG, or WebP · 25 MB maximum · secure viewing and downloading</span></div>
                <div class="licensing-document-upload-controls">
                  <label class="file-picker"><span>Choose document</span><input aria-label="Choose document" type="file" /></label>
                  <button class="secondary-button" type="button">Upload document</button>
                </div>
              </div>
              <div class="licensing-document-workspace">
                <div class="licensing-document-list">
                  ${documents.map(([name, detail]) => `<article><span class="licensing-document-list__icon">▤</span><div><strong>${name}</strong><span>${detail}</span></div><div class="licensing-document-list__actions"><button class="secondary-button secondary-button--small" type="button">View</button><button class="secondary-button secondary-button--small" type="button">Download</button></div></article>`).join('')}
                </div>
                <div class="licensing-document-pagination"><span>12 documents</span><label>Rows<select><option>5</option><option>10</option><option>20</option></select></label><button class="secondary-button secondary-button--small" disabled type="button">Previous</button><span>Page 1 of 3</span><button class="secondary-button secondary-button--small" type="button">Next</button></div>
              </div>
            </section>
          </dialog>
        </main>`
    })

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: 'View' })).toHaveCount(5)
    await expect(dialog.getByRole('button', { name: 'Download' })).toHaveCount(5)
    await expect(dialog.locator('.licensing-document-list article')).toHaveCount(5)

    for (const control of await dialog.locator('button, input, select').all()) {
      const box = await control.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.height).toBeGreaterThanOrEqual(38)
    }

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)
    const accessibility = await new AxeBuilder({ page }).analyze()
    expect(accessibility.violations).toEqual([])

    await page.screenshot({ path: testInfo.outputPath(`licensing-documents-${colorScheme}.png`), fullPage: true })
  })
}
