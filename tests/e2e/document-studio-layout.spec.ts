import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

async function installStudioFixture(page: import('@playwright/test').Page, theme: 'light' | 'dark') {
  await page.evaluate((selectedTheme) => {
    document.documentElement.dataset.theme = selectedTheme
    document.documentElement.style.colorScheme = selectedTheme
    document.body.innerHTML = `<main style="max-width:1440px;margin:0 auto;padding:24px"><h1>Document Studio</h1>
      <section class="document-studio" aria-label="Document Studio">
        <div class="document-studio__release held"><span aria-hidden="true">⛨</span><div><strong>Security release held</strong><span>The system is installed, but document uploads remain closed until the scanner canary and recovery drill pass.</span></div></div>
        <div class="document-studio__metrics"><article><span>Documents</span><strong>14</strong></article><article><span>Templates</span><strong>4</strong></article><article><span>Awaiting action</span><strong>3</strong></article><article><span>Completed</span><strong>11</strong></article><article class="attention"><span>Exceptions</span><strong>1</strong></article></div>
        <div class="document-studio__tabs" role="tablist" aria-label="Document Studio sections"><button aria-selected="false" role="tab">Overview</button><button aria-selected="false" role="tab">Templates</button><button aria-selected="true" class="active" role="tab">Signatures</button><button aria-selected="false" role="tab">Policies</button><button aria-selected="false" role="tab">Processing</button></div>
        <div class="document-studio__section"><div class="document-studio__heading"><div><h2>Signature envelopes</h2><p>Sequential or parallel routing with exact-version integrity and recipient evidence.</p></div><button class="primary-action" type="button">New envelope</button></div><div class="document-studio__list">${Array.from({ length: 5 }, (_, index) => `<article><div><strong>Employee policy ${index + 1}</strong><span>Policy acknowledgment · Standard policy</span><small>${index + 1}/2 complete</small></div><span class="document-studio__status is-waiting">waiting</span><div class="document-studio__row-actions"><button class="secondary-button secondary-button--small" type="button">Void</button></div></article>`).join('')}</div></div>
      </section>
    </main>`
  }, theme)
}

async function installSignatureFixture(page: import('@playwright/test').Page, theme: 'light' | 'dark') {
  await page.evaluate((selectedTheme) => {
    document.documentElement.dataset.theme = selectedTheme
    document.documentElement.style.colorScheme = selectedTheme
    document.body.innerHTML = `<dialog aria-labelledby="signature-title" class="modal-dialog signature-execution-dialog" open><div class="modal-dialog__heading"><div><h2 id="signature-title">Employee acknowledgment</h2><p>Policy.pdf · Version 1 · employee</p></div><button aria-label="Close dialog" class="modal-close" type="button">×</button></div><form class="signature-execution"><div class="signature-execution__document"><section class="secure-pdf-viewer" aria-label="Protected PDF"><div style="background:#fff;color:#111;min-height:560px;padding:32px"><h2>Protected PDF preview</h2><p>Exact clean source version.</p></div></section></div><aside class="signature-execution__panel"><div class="signature-execution__section"><p class="eyebrow">Required fields</p><h3>Complete your information</h3><label>Employee statement<input aria-label="Employee statement" value="Reviewed" /></label></div><div class="signature-execution__section signature-appearance"><p class="eyebrow">Signature appearance</p><h3>Adopt your signature</h3><div class="signature-appearance__methods"><button class="active" type="button">Typed</button><button type="button">Drawn</button><button type="button">Uploaded</button></div><label>Legal display name<input aria-label="Legal display name" value="Jordan Brown" /></label></div><div class="signature-execution__consent"><label><input aria-label="Electronic signature consent" checked type="checkbox"/><span><strong>I agree and intend to sign electronically.</strong>I reviewed this document and consent to this electronic action.</span></label><small>Consent version 1.0 · Source checksum 0123456789ab…</small></div><div class="modal-actions"><button class="secondary-button" type="button">Not now</button><button class="primary-action" type="submit">Adopt &amp; sign</button></div></aside></form></dialog>`
  }, theme)
}

for (const theme of ['light', 'dark'] as const) {
  test(`Document Studio remains compact and accessible in ${theme} mode`, async ({ page }, testInfo) => {
    await page.goto('/')
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim().length > 0)
    await installStudioFixture(page, theme)
    await expect(page.locator('.document-studio__list article')).toHaveCount(5)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    const accessibility = await new AxeBuilder({ page }).analyze()
    expect(accessibility.violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`document-studio-${theme}.png`), fullPage: true })
  })

  test(`Signature execution remains contained and accessible in ${theme} mode`, async ({ page }, testInfo) => {
    await page.goto('/')
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim().length > 0)
    await installSignatureFixture(page, theme)
    const dialog = page.getByRole('dialog')
    const box = await dialog.boundingBox()
    const viewport = page.viewportSize()
    expect(box).not.toBeNull()
    expect(viewport).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(4)
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width - 4)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    const accessibility = await new AxeBuilder({ page }).analyze()
    expect(accessibility.violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`signature-execution-${theme}.png`), fullPage: true })
  })
}
