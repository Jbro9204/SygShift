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
      <section class="hr-documents-inventory"><div class="hr-documents-inventory__summary"><span><strong>1</strong> matching document</span><span>Page 1 of 1</span></div><div class="hr-documents-list"><article class="hr-document-row"><button aria-expanded="false" class="hr-document-row__summary" type="button"><span class="hr-document-row__icon">▤</span><span class="hr-document-row__identity"><strong>Zach Ward Medical Excuse 9.11.26</strong><small>Zachary Alexander Ward · SYG-1058</small></span><span><small>Category</small><strong>Business document</strong><em>hr-general</em></span><span><small>Access</small><strong>Confidential</strong><em class="hr-scan-state hr-scan-state--clean">Ready</em></span><span><small>Version</small><strong>Version 1</strong><em>09/11/2026 2:00 PM</em></span><span aria-hidden="true">⌄</span></button></article></div><div class="hr-documents-pagination"><button class="secondary-button" disabled type="button">Previous</button><span>1 of 1</span><button class="secondary-button" disabled type="button">Next</button></div></section>
    </main>`
  }, theme)
}

for (const theme of ['light', 'dark'] as const) {
  test(`employee documents stay obvious, contained, and accessible in ${theme} mode`, async ({ page }, testInfo) => {
    await page.goto('/')
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim().length > 0)
    await installEmployeeDocumentFixture(page, theme)

    await expect(page.getByRole('link', { name: /Open employee files/ })).toBeVisible()
    await expect(page.getByRole('region', { exact: true, name: 'Documents for Zachary Alexander Ward' })).toBeVisible()
    await expect(page.getByText('Zach Ward Medical Excuse 9.11.26')).toBeVisible()
    for (const control of await page.locator('.hr-file-documents-entry .primary-action, .hr-documents-employee-focus__actions > *, .hr-documents-toolbar button, .hr-documents-toolbar input:not([type="checkbox"]), .hr-documents-toolbar select').all()) {
      const box = await control.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.height).toBeGreaterThanOrEqual(40)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`employee-document-discovery-${theme}.png`), fullPage: true })
  })
}
