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
        <div class="document-studio__tabs" role="tablist" aria-label="Document Studio sections"><button aria-selected="false" role="tab">Start</button><button aria-selected="true" class="active" role="tab">Signature requests</button><button aria-selected="false" role="tab">Form library</button><button aria-selected="false" role="tab">Templates</button><button aria-selected="false" role="tab">Administration</button><button aria-selected="false" role="tab">Processing</button></div>
        <div class="document-studio__section"><div class="document-studio__heading"><div><h2>Signature requests</h2><p>Send new outside documents or track requests that are already in progress.</p></div><div class="document-studio__row-actions"><button class="secondary-button" type="button">Use existing document</button><button class="primary-action" type="button">Send new document</button></div></div><div class="document-studio__list">${Array.from({ length: 5 }, (_, index) => `<article><div><strong>Employee policy ${index + 1}</strong><span>Policy acknowledgment · Standard policy</span><small>${index + 1}/2 complete</small></div><span class="document-studio__status is-waiting">waiting</span><div class="document-studio__row-actions"><button class="secondary-button secondary-button--small" type="button">Void</button></div></article>`).join('')}</div></div>
      </section>
    </main>`
  }, theme)
}

async function installSendDocumentFixture(page: import('@playwright/test').Page, theme: 'light' | 'dark') {
  await page.evaluate((selectedTheme) => {
    document.documentElement.dataset.theme = selectedTheme
    document.documentElement.style.colorScheme = selectedTheme
    document.body.innerHTML = `<dialog aria-labelledby="send-document-title" class="modal-dialog document-signature-wizard" open><div class="modal-dialog__heading"><div><h2 id="send-document-title">Send a document</h2><p>Upload an outside document and send it to one or more SygShift employees without building a policy or template first.</p></div><button aria-label="Close dialog" class="modal-close" type="button">×</button></div><div class="document-signature-wizard__body"><ol class="document-signature-wizard__steps" aria-label="Document delivery progress"><li class="complete"><span>✓</span><strong>Document</strong></li><li class="current"><span>2</span><strong>People</strong></li><li><span>3</span><strong>Review</strong></li><li><span>4</span><strong>Send</strong></li></ol><form class="document-signature-wizard__panel"><header><span aria-hidden="true">👥</span><div><h3>Who needs to complete it?</h3><p>Choose up to 25 active SygShift employees.</p></div></header><label class="document-signature-wizard__action">What should they do?<select><option>Sign</option></select></label><label class="document-signature-wizard__search"><span>Find employees</span><div><svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"></circle><path d="m20 20-3.5-3.5" stroke="currentColor" stroke-width="2"></path></svg><input aria-label="Find employees" placeholder="Name or employee number"/></div></label><div class="document-signature-wizard__people" role="group" aria-label="Employees"><p>2 selected</p>${['Jordan Employee','Sandy Manager','Michael Dispatcher','Zach Supervisor','Angelica Hood','Roman Guard'].map((name, index) => `<label><input ${index < 2 ? 'checked' : ''} type="checkbox"/><span><strong>${name}</strong><small>SYG-${1000 + index}</small></span></label>`).join('')}</div><footer><button class="secondary-button" type="button">Back</button><button class="primary-action" type="submit">Review request</button></footer></form></div></dialog>`
  }, theme)
}

async function installSendDocumentFieldsFixture(page: import('@playwright/test').Page, theme: 'light' | 'dark') {
  await page.evaluate((selectedTheme) => {
    document.documentElement.dataset.theme = selectedTheme
    document.documentElement.style.colorScheme = selectedTheme
    document.body.innerHTML = `<dialog aria-labelledby="send-document-fields-title" class="modal-dialog document-signature-wizard" open><div class="modal-dialog__heading"><div><h2 id="send-document-fields-title">Send a document</h2><p>Upload an outside document and send it to one or more SygShift employees without building a policy or template first.</p></div><button aria-label="Close dialog" class="modal-close" type="button">×</button></div><div class="document-signature-wizard__body"><ol class="document-signature-wizard__steps" aria-label="Document delivery progress"><li class="current"><span>1</span><strong>Document</strong></li><li><span>2</span><strong>People</strong></li><li><span>3</span><strong>Review</strong></li><li><span>4</span><strong>Send</strong></li></ol><form class="document-signature-wizard__panel"><header><svg aria-hidden="true" height="24" viewBox="0 0 24 24" width="24"><path d="M12 3v12m-4-4 4 4 4-4M5 19h14" fill="none" stroke="currentColor" stroke-width="2"></path></svg><div><h3>Choose the document</h3><p>Upload a proposal, agreement, policy, or other supported outside document.</p></div></header><div class="document-signature-wizard__dropzone"><strong>employee-policy.pdf</strong><span>6.6 MB</span><button class="secondary-button" type="button">Choose another file</button></div><div class="document-signature-wizard__grid"><label>Document title<input aria-label="Document title" value="Employee policy"/></label><label>What kind of document is this?<select aria-label="Document category"><option>Policy or acknowledgment</option></select></label></div><details class="document-signature-wizard__advanced" open><summary>Optional filing details</summary><div class="document-signature-wizard__grid"><label>File with<select aria-label="File with"><option>Company / shared records</option></select></label><label>Protected document area<select aria-label="Protected document area"><option>Legal, safety, and separation</option></select></label><label class="wide">Internal description<textarea aria-label="Internal description" rows="3">Company licensing</textarea></label></div></details><p class="document-signature-wizard__automatic">SygShift will use <strong>Legal, safety, and separation</strong> automatically.</p><footer><button class="secondary-button" type="button">Cancel</button><button class="primary-action" type="submit">Choose recipients</button></footer></form></div></dialog>`
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

  test(`Guided document delivery remains usable in ${theme} mode`, async ({ page }, testInfo) => {
    await page.goto('/')
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim().length > 0)
    await installSendDocumentFixture(page, theme)
    const dialog = page.getByRole('dialog')
    const box = await dialog.boundingBox()
    const viewport = page.viewportSize()
    expect(box).not.toBeNull()
    expect(viewport).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(4)
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width - 4)
    await expect(page.getByRole('button', { name: 'Review request' })).toBeVisible()
    const recipientControlStyles = await page.getByPlaceholder('Name or employee number').evaluate((field) => {
      const style = getComputedStyle(field)
      return { borderRadius: parseFloat(style.borderRadius), fontFamily: style.fontFamily, fontSize: parseFloat(style.fontSize), height: field.getBoundingClientRect().height, paddingLeft: parseFloat(style.paddingLeft) }
    })
    expect(recipientControlStyles.borderRadius).toBeGreaterThanOrEqual(12)
    expect(recipientControlStyles.fontFamily.toLowerCase()).not.toContain('monospace')
    expect(recipientControlStyles.fontSize).toBeGreaterThanOrEqual(15)
    expect(recipientControlStyles.height).toBeGreaterThanOrEqual(48)
    expect(recipientControlStyles.paddingLeft).toBeGreaterThanOrEqual(44)
    const employeeCardRadius = await page.locator('.document-signature-wizard__people label').first().evaluate((card) => parseFloat(getComputedStyle(card).borderRadius))
    expect(employeeCardRadius).toBeGreaterThanOrEqual(12)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    const accessibility = await new AxeBuilder({ page }).analyze()
    expect(accessibility.violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`document-delivery-${theme}.png`), fullPage: true })
  })

  test(`Guided document fields use rounded readable controls in ${theme} mode`, async ({ page }, testInfo) => {
    await page.goto('/')
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim().length > 0)
    await installSendDocumentFieldsFixture(page, theme)
    const fields = [page.getByLabel('Document title'), page.getByLabel('Document category'), page.getByLabel('Internal description')]
    for (const field of fields) {
      const styles = await field.evaluate((control) => {
        const style = getComputedStyle(control)
        return { borderRadius: parseFloat(style.borderRadius), fontFamily: style.fontFamily, fontSize: parseFloat(style.fontSize), paddingLeft: parseFloat(style.paddingLeft) }
      })
      expect(styles.borderRadius).toBeGreaterThanOrEqual(12)
      expect(styles.fontFamily.toLowerCase()).not.toContain('monospace')
      expect(styles.fontSize).toBeGreaterThanOrEqual(15)
      expect(styles.paddingLeft).toBeGreaterThanOrEqual(14)
    }
    expect(await page.getByLabel('Document title').evaluate((field) => field.getBoundingClientRect().height)).toBeGreaterThanOrEqual(48)
    expect(await page.getByLabel('Internal description').evaluate((field) => field.getBoundingClientRect().height)).toBeGreaterThanOrEqual(120)
    expect(await page.locator('.document-signature-wizard__advanced').evaluate((card) => parseFloat(getComputedStyle(card).borderRadius))).toBeGreaterThanOrEqual(14)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    const accessibility = await new AxeBuilder({ page }).analyze()
    expect(accessibility.violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`document-delivery-fields-${theme}.png`), fullPage: true })
  })
}
