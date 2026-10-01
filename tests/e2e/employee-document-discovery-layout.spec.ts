import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

async function installEmployeeDocumentFixture(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((selectedTheme) => {
    document.documentElement.dataset.theme = selectedTheme
    document.documentElement.style.colorScheme = selectedTheme
    document.body.innerHTML = `<main class="hr-file-page">
      <header class="hr-file-hero"><div class="hr-file-avatar">ZW</div><div><p class="eyebrow">Employee File</p><h1>Zachary Alexander Ward</h1><p>SYG-1058 · @zward</p></div><div class="hr-file-hero__status"><span>Active</span><small>Guard</small></div></header>
      <section class="hr-file-documents-entry" aria-label="Files and documents for Zachary Alexander Ward">
        <span class="hr-file-documents-entry__icon" aria-hidden="true">▤</span>
        <div><p class="eyebrow">Employee documents</p><h2>Files for Zachary Alexander Ward</h2><p>Open every document filed to this employee, including uploads that are still finishing in the background.</p></div>
        <span class="hr-file-documents-entry__count"><strong>1</strong><small>file</small></span>
        <a class="primary-action" href="#focused-files">Open employee files <span aria-hidden="true">↗</span></a>
      </section>
      <section class="hr-documents-employee-focus" aria-label="Documents for Zachary Alexander Ward" id="focused-files">
        <span class="hr-documents-employee-focus__icon" aria-hidden="true">▤</span>
        <div><p class="eyebrow">Employee file</p><h2>Zachary Alexander Ward</h2><p>This view contains only documents filed to this employee. New uploads appear here as soon as they are saved.</p></div>
        <span class="hr-documents-employee-focus__count"><strong>1</strong><small>document</small></span>
        <div class="hr-documents-employee-focus__actions"><a class="secondary-button" href="#employee">← Employee File</a><button class="primary-action" type="button">Add document</button><button class="secondary-button" type="button">View all documents</button></div>
      </section>
      <section class="hr-documents-toolbar"><div class="hr-documents-toolbar__heading"><div><p class="eyebrow">Document inventory</p><h2>Files for Zachary Alexander Ward</h2><p>Every current file assigned to this employee is shown below.</p></div><button class="primary-action" type="button">Add document</button></div><div class="hr-documents-filters"><form><label for="file-search">Search</label><div><span aria-hidden="true">⌕</span><input id="file-search" placeholder="Title, category, employee, or file"></div><button class="secondary-button" type="submit">Search</button></form><label>Employee<select><option>Zachary Alexander Ward · SYG-1058</option></select></label><label>Vault<select><option>All authorized vaults</option></select></label><label>Rows<select><option>10</option></select></label><label class="hr-documents-archive-filter"><input type="checkbox">Include archived</label></div></section>
      <section class="hr-documents-inventory">
        <div class="hr-documents-inventory__summary"><span><strong>1</strong> matching document</span><span>Page 1 of 1</span></div>
        <div class="hr-documents-list">
          <article class="hr-document-row hr-document-row--employee_record">
            <button aria-controls="fixture-document-details" aria-expanded="true" class="hr-document-row__summary" type="button"><span class="hr-document-row__icon">▤</span><span class="hr-document-row__identity"><strong>Zachary Ward Medical Excuse and Continuing Follow-Up Documentation 9.11.26</strong><span class="hr-document-record-badge hr-document-record-badge--employee_record">Finished employee record</span><small>Zachary Alexander Ward · SYG-1058</small></span><span class="hr-document-row__classification"><small>Category</small><strong>Business document</strong><em>Personnel File / Confidential Medical Support</em></span><span><small>Access &amp; file</small><strong>Confidential</strong><em class="hr-document-availability hr-document-availability--available">Available</em></span><span><small>Saved version</small><strong>Version 1</strong><em>09/11/2026 2:00 PM</em></span><span aria-hidden="true">⌃</span></button>
            <div class="hr-document-row__details" id="fixture-document-details">
              <dl>
                <div><dt>Record type</dt><dd><strong>Finished employee record</strong><span>Completed work saved to one employee file.</span></dd></div>
                <div><dt>Description</dt><dd>Doctor's excuse for work and continuing medical follow-up.</dd></div>
                <div><dt>Record owner</dt><dd>Zachary Alexander Ward · SYG-1058</dd></div>
                <div><dt>Category &amp; filing area</dt><dd>Business document<span>hr-general</span></dd></div>
                <div><dt>Effective / expiration</dt><dd>09/11/2026<span>Expires Not recorded</span></dd></div>
                <div><dt>File</dt><dd>Zachary Ward Medical Excuse and Continuing Follow-Up Documentation 9.11.26 - supporting documentation.pdf · 719 KB</dd></div>
              </dl>
              <div aria-label="Actions for Zachary Ward Medical Excuse and Continuing Follow-Up Documentation" class="hr-document-row__actions" role="group"><button class="primary-action" type="button">Work on a copy</button><button class="secondary-button" type="button">Preview</button><button class="secondary-button" type="button">Download</button><button class="danger-button" type="button">Remove from employee file</button></div>
            </div>
          </article>
        </div>
        <div class="hr-documents-pagination"><button class="secondary-button" disabled type="button">Previous</button><span>1 of 1</span><button class="secondary-button" disabled type="button">Next</button></div>
      </section>
    </main>`
  }, theme)
}

async function expectExpandedDocumentLayout(page: Page) {
  const geometry = await page.locator('.hr-document-row__details').evaluate((details) => {
    const metadata = details.querySelector('dl')!.getBoundingClientRect()
    const actions = details.querySelector('.hr-document-row__actions')!.getBoundingClientRect()
    const file = details.querySelector('dl > div:last-child dd')!.getBoundingClientRect()
    const title = details.parentElement!.querySelector<HTMLElement>('.hr-document-row__identity > strong')!
    const buttons = Array.from(details.querySelectorAll<HTMLButtonElement>('.hr-document-row__actions button'))
      .map((button) => button.getBoundingClientRect())
    const buttonsOverlap = buttons.some((button, index) => buttons.slice(index + 1).some((other) => (
      button.left < other.right
      && button.right > other.left
      && button.top < other.bottom
      && button.bottom > other.top
    )))
    return {
      actionsTop: actions.top,
      buttonsOverlap,
      detailsContained: details.scrollWidth <= details.clientWidth + 1,
      fileWidth: file.width,
      metadataBottom: metadata.bottom,
      minimumButtonHeight: Math.min(...buttons.map((button) => button.height)),
      titleContained: title.scrollWidth <= title.clientWidth + 1 && getComputedStyle(title).whiteSpace === 'normal',
    }
  })
  expect(geometry.actionsTop).toBeGreaterThanOrEqual(geometry.metadataBottom + 14)
  expect(geometry.buttonsOverlap).toBe(false)
  expect(geometry.detailsContained).toBe(true)
  expect(geometry.fileWidth).toBeGreaterThanOrEqual(180)
  expect(geometry.minimumButtonHeight).toBeGreaterThanOrEqual(44)
  expect(geometry.titleContained).toBe(true)
}

for (const theme of ['light', 'dark'] as const) {
  test(`employee documents stay obvious, contained, and accessible in ${theme} mode`, async ({ page }, testInfo) => {
    await page.goto('/')
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim().length > 0)
    await installEmployeeDocumentFixture(page, theme)

    await expect(page.getByRole('link', { name: /Open employee files/ })).toBeVisible()
    await expect(page.getByRole('region', { exact: true, name: 'Documents for Zachary Alexander Ward' })).toBeVisible()
    await expect(page.locator('.hr-document-row__identity > strong')).toHaveText('Zachary Ward Medical Excuse and Continuing Follow-Up Documentation 9.11.26')
    await expectExpandedDocumentLayout(page)
    for (const control of await page.locator('.hr-file-documents-entry .primary-action, .hr-documents-employee-focus__actions > *, .hr-documents-toolbar button, .hr-documents-toolbar input:not([type="checkbox"]), .hr-documents-toolbar select').all()) {
      const box = await control.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.height).toBeGreaterThanOrEqual(44)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`employee-document-discovery-${theme}.png`), fullPage: true })
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`expanded employee document stays balanced across laptop and compact widths in ${theme} mode`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium')
    const viewports = [
      { height: 900, width: 1461 },
      { height: 768, width: 1366 },
      { height: 640, width: 1024 },
      { height: 768, width: 768 },
      // A 1280 × 720 desktop viewport exposes about 640 × 360 CSS pixels at 200% browser zoom.
      { height: 360, width: 640 },
      { height: 720, width: 390 },
      { height: 568, width: 320 },
    ]
    for (const viewport of viewports) {
      await page.setViewportSize(viewport)
      await page.goto('/')
      await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim().length > 0)
      await installEmployeeDocumentFixture(page, theme)
      await expectExpandedDocumentLayout(page)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
      await page.screenshot({ path: testInfo.outputPath(`employee-document-expanded-${viewport.width}x${viewport.height}-${theme}.png`), fullPage: true })
    }
  })
}
