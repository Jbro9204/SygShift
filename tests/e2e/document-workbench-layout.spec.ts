import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

async function installWorkbenchFixture(page: import('@playwright/test').Page, theme: 'light' | 'dark', panel: 'edit' | 'file') {
  await page.evaluate(({ selectedPanel, selectedTheme }) => {
    document.documentElement.dataset.theme = selectedTheme
    document.documentElement.style.colorScheme = selectedTheme
    const editPanel = `<div class="document-workbench__panel"><div><p class="eyebrow">Add to the PDF</p><h3>Choose a tool, then click the page</h3><p>Every addition can be undone or removed before you finish.</p></div><div class="document-workbench__tools"><button class="active" type="button">T <span>Text</span></button><button type="button">✒ <span>Signature</span></button><button type="button">▣ <span>Date</span></button><button type="button">✓ <span>Check</span></button></div><label class="document-workbench__field">Text to add<input value="Approved proposal"/></label><p class="document-workbench__tip">Tip: additions on the page are removable—click one to take it off.</p></div>`
    const filePanel = `<div class="document-workbench__panel"><div><p class="eyebrow">Save to SygShift</p><h3>Add to an employee file</h3><p>The filing area is selected automatically. Choose only the person.</p></div><label class="document-workbench__field">Document title<input value="Compensation proposal"/></label><label class="document-workbench__field">Find an employee<div class="document-workbench__search"><span aria-hidden="true">⌕</span><input placeholder="Search by name or employee number" value="Michelle"/></div></label><div class="document-workbench__people"><label class="document-workbench__choice"><input checked name="employee" type="radio"/><span><strong>Michelle Hood</strong><small>SYG-1042</small></span></label><label class="document-workbench__choice"><input name="employee" type="radio"/><span><strong>Michael Hinz</strong><small>SYG-1017</small></span></label></div><label class="document-workbench__field">Document type<select><option>Proposal</option></select></label><label class="document-workbench__field">Note <span>Optional</span><textarea rows="3">Reviewed compensation proposal</textarea></label><button class="primary-action document-workbench__wide-action" type="button">Add to employee file</button></div>`
    document.body.innerHTML = `<dialog aria-labelledby="workbench-title" class="modal-dialog document-workbench" open><div class="modal-dialog__heading"><div class="modal-dialog__heading-copy"><h2 id="workbench-title">Compensation proposal</h2><p>Type, sign, download, send, or add this PDF to an employee file from one place.</p></div><button aria-label="Close dialog" class="modal-close" type="button">×</button></div><div class="document-workbench__body"><header class="document-workbench__toolbar"><div class="document-workbench__paging"><button aria-label="Previous page" disabled>‹</button><strong>Page 1 of 2</strong><button aria-label="Next page">›</button></div><div class="document-workbench__history"><button aria-label="Undo">↶</button><button aria-label="Redo" disabled>↷</button></div><button class="secondary-button secondary-button--small" type="button">Choose another PDF</button></header><div class="document-workbench__main"><section class="document-workbench__document"><div class="document-workbench__sheet" style="width:650px;height:820px"><div style="padding:64px;color:#111"><h2>Compensation Proposal</h2><p>Employee: Michelle Hood</p></div><button class="document-workbench__annotation is-text" style="left:28%;top:42%" type="button">Approved proposal</button></div></section><aside class="document-workbench__side"><div class="document-workbench__side-tabs" role="tablist" aria-label="Document actions"><button aria-selected="${selectedPanel === 'edit'}" class="${selectedPanel === 'edit' ? 'active' : ''}" role="tab">Edit</button><button aria-selected="${selectedPanel === 'file'}" class="${selectedPanel === 'file' ? 'active' : ''}" role="tab">File</button><button aria-selected="false" role="tab">Send</button></div>${selectedPanel === 'edit' ? editPanel : filePanel}</aside></div><footer class="document-workbench__footer"><div><span>1 addition · Changes are applied when you download, send, or file the PDF.</span></div><div><button class="secondary-button">Close</button><button class="primary-action">Download PDF</button></div></footer></div></dialog>`
  }, { selectedPanel: panel, selectedTheme: theme })
}

for (const theme of ['light', 'dark'] as const) {
  test(`PDF workbench is contained and readable in ${theme} mode`, async ({ page }, testInfo) => {
    await page.goto('/')
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim().length > 0)
    await installWorkbenchFixture(page, theme, 'edit')
    await expect(page.getByRole('button', { name: 'Download PDF' })).toBeVisible()
    await expect(page.getByText('Choose a tool, then click the page')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    const dialog = page.getByRole('dialog')
    const box = await dialog.boundingBox()
    const viewport = page.viewportSize()
    expect(box).not.toBeNull()
    expect(viewport).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(4)
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width - 4)
    const accessibility = await new AxeBuilder({ page }).analyze()
    expect(accessibility.violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`document-workbench-${theme}.png`), fullPage: true })
  })

  test(`employee-file destination stays usable in ${theme} mode`, async ({ page }, testInfo) => {
    await page.goto('/')
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim().length > 0)
    await installWorkbenchFixture(page, theme, 'file')
    await expect(page.getByRole('button', { name: 'Add to employee file' })).toBeVisible()
    const search = page.getByPlaceholder('Search by name or employee number')
    const styles = await search.evaluate((control) => {
      const style = getComputedStyle(control)
      return { borderRadius: parseFloat(style.borderRadius), fontSize: parseFloat(style.fontSize), height: control.getBoundingClientRect().height }
    })
    expect(styles.borderRadius).toBeGreaterThanOrEqual(10)
    expect(styles.fontSize).toBeGreaterThanOrEqual(15)
    expect(styles.height).toBeGreaterThanOrEqual(44)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    const accessibility = await new AxeBuilder({ page }).analyze()
    expect(accessibility.violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`document-employee-file-${theme}.png`), fullPage: true })
  })
}
