import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

type Panel = 'edit' | 'file' | 'send'

async function installWorkbenchFixture(page: Page, theme: 'light' | 'dark', panel: Panel) {
  await page.evaluate(({ selectedPanel, selectedTheme }) => {
    document.documentElement.dataset.theme = selectedTheme
    document.documentElement.style.colorScheme = selectedTheme
    const searchIcon = '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>'
    const editPanel = `<div class="document-workbench__panel"><div><p class="eyebrow">Add to the PDF</p><h3>Choose a tool, then click the page</h3><p>Every addition can be undone or removed before you finish.</p></div><div class="document-workbench__tools"><button class="active" type="button">T <span>Text</span></button><button type="button">✒ <span>Signature</span></button><button type="button">▣ <span>Date</span></button><button type="button">✓ <span>Check</span></button></div><label class="document-workbench__field">Selected text box<textarea rows="4">John Holliday requires an unlimited plainclothes endorsement to provide discreet executive-protection services.\nApproved for the listed assignment.</textarea></label><section aria-label="Selected text box controls" class="document-workbench__text-controls"><div class="document-workbench__selection-heading"><span>↔</span><div><strong>Selected text box</strong><small>Drag the text to move it. Drag its gold corner to resize the box.</small></div></div><div class="document-workbench__size-control"><span>Text size</span><div><button aria-label="Decrease text size">−</button><output>12 pt</output><button aria-label="Increase text size">+</button></div></div><label class="document-workbench__width-control">Text box width <output>44%</output><input aria-label="Text box width" max="88" min="16" type="range" value="44"></label></section><p class="document-workbench__tip">Tip: select an item to move it. Text boxes can also wrap, resize, and be edited after placement.</p></div>`
    const filePanel = `<div class="document-workbench__panel"><div><p class="eyebrow">Save to SygShift</p><h3>Add to an employee file</h3><p>The filing area is selected automatically. Choose only the person.</p></div><label class="document-workbench__field">Document title<input value="Compensation proposal"></label><label class="document-workbench__field">Find an employee<div class="document-workbench__search">${searchIcon}<input placeholder="Search by name or employee number" value="Michelle"></div></label><div class="document-workbench__people"><label class="document-workbench__choice"><input checked name="employee" type="radio"><span><strong>Michelle Hood</strong><small>SYG-1042</small></span></label><label class="document-workbench__choice"><input name="employee" type="radio"><span><strong>Michael Hinz</strong><small>SYG-1017</small></span></label></div><label class="document-workbench__field">Document type<select><option>Proposal</option></select></label><button class="primary-action document-workbench__wide-action" type="button">Add to employee file</button></div>`
    const sendPanel = `<div class="document-workbench__panel"><div><p class="eyebrow">Send from SygShift</p><h3>Who needs this document?</h3><p>Choose the people and what they need to do.</p></div><label class="document-workbench__field">Action<select><option>Sign document</option></select></label><label class="document-workbench__field">Find recipients<div class="document-workbench__search">${searchIcon}<input placeholder="Search employees" value="Michael"></div></label><div class="document-workbench__people"><p>1 selected</p><label class="document-workbench__choice"><input checked type="checkbox"><span><strong>Michael Hinz</strong><small>SYG-1017</small></span></label></div><label class="document-workbench__field">Message <span>Optional</span><textarea rows="3">Please review and sign.</textarea></label><button class="primary-action document-workbench__wide-action" type="button">Send document</button></div>`
    const panels: Record<Panel, string> = { edit: editPanel, file: filePanel, send: sendPanel }
    document.body.innerHTML = `<dialog aria-labelledby="workbench-title" class="modal-dialog document-workbench" open><div class="modal-dialog__heading"><div class="modal-dialog__heading-copy"><h2 id="workbench-title">Compensation proposal</h2><p>Type, sign, download, send, or add this PDF to an employee file from one place.</p></div><button aria-label="Close dialog" class="modal-close" type="button">×</button></div><div class="document-workbench__body"><header class="document-workbench__toolbar"><div class="document-workbench__paging"><button aria-label="Previous page" disabled>‹</button><strong>Page 1 of 2</strong><button aria-label="Next page">›</button></div><div class="document-workbench__history"><button aria-label="Undo last document change">↶</button><button aria-label="Redo last document change" disabled>↷</button></div><button aria-label="Maximize editor" aria-pressed="false" class="document-workbench__maximize" type="button">⛶</button><button class="secondary-button secondary-button--small" type="button">Choose another PDF</button></header><div class="document-workbench__main"><section class="document-workbench__document"><div class="document-workbench__sheet" style="width:650px;height:820px"><div style="padding:64px;color:#111"><h2>Compensation Proposal</h2><p>Employee: Michelle Hood</p></div><div class="document-workbench__annotation is-text is-selected" style="left:18%;top:36%;width:44%;font-size:12px"><button aria-label="Text box: John Holliday requires an unlimited plainclothes endorsement" aria-pressed="true" class="document-workbench__annotation-content" type="button">John Holliday requires an unlimited plainclothes endorsement to provide discreet executive-protection services for his scheduled assignment.</button><button aria-label="Resize selected text box" class="document-workbench__resize-handle" type="button">↘</button></div></div></section><aside class="document-workbench__side"><div class="document-workbench__side-tabs" role="tablist" aria-label="Document actions"><button aria-selected="${selectedPanel === 'edit'}" class="${selectedPanel === 'edit' ? 'active' : ''}" role="tab">Edit</button><button aria-selected="${selectedPanel === 'file'}" class="${selectedPanel === 'file' ? 'active' : ''}" role="tab">File</button><button aria-selected="${selectedPanel === 'send'}" class="${selectedPanel === 'send' ? 'active' : ''}" role="tab">Send</button></div>${panels[selectedPanel]}</aside></div><footer class="document-workbench__footer"><div><span>1 addition · Changes are applied when you download, send, or file the PDF.</span></div><div><button class="secondary-button">Close</button><button class="secondary-button">Preview finished PDF</button><button class="primary-action">Download PDF</button></div></footer></div></dialog>`
    const dialog = document.querySelector<HTMLDialogElement>('.document-workbench')!
    const maximize = document.querySelector<HTMLButtonElement>('.document-workbench__maximize')!
    maximize.addEventListener('click', () => {
      const maximized = dialog.classList.toggle('is-maximized')
      maximize.setAttribute('aria-label', maximized ? 'Restore editor size' : 'Maximize editor')
      maximize.setAttribute('aria-pressed', String(maximized))
    })
  }, { selectedPanel: panel, selectedTheme: theme })
}

async function expectSearchIconClear(page: Page, placeholder: string) {
  const input = page.getByPlaceholder(placeholder)
  const geometry = await input.evaluate((control) => {
    const inputStyle = getComputedStyle(control)
    const inputBox = control.getBoundingClientRect()
    const icon = control.previousElementSibling as SVGElement
    const iconBox = icon.getBoundingClientRect()
    return {
      borderRadius: Number.parseFloat(inputStyle.borderRadius),
      fontSize: Number.parseFloat(inputStyle.fontSize),
      height: inputBox.height,
      iconRight: iconBox.right,
      textStart: inputBox.left + Number.parseFloat(inputStyle.paddingLeft),
    }
  })
  expect(geometry.borderRadius).toBeGreaterThanOrEqual(10)
  expect(geometry.fontSize).toBeGreaterThanOrEqual(15)
  expect(geometry.height).toBeGreaterThanOrEqual(44)
  expect(geometry.textStart - geometry.iconRight).toBeGreaterThanOrEqual(6)
}

for (const theme of ['light', 'dark'] as const) {
  test(`PDF workbench text editing is contained and readable in ${theme} mode`, async ({ page }, testInfo) => {
    await page.goto('/')
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim().length > 0)
    await installWorkbenchFixture(page, theme, 'edit')
    const textBox = page.getByRole('button', { name: /Text box: John Holliday/ })
    await expect(textBox).toBeVisible()
    expect(await textBox.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    await page.getByRole('button', { name: 'Maximize editor' }).click()
    await expect(page.getByRole('dialog')).toHaveClass(/is-maximized/)
    await expect(page.getByRole('button', { name: 'Restore editor size' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`document-workbench-${theme}.png`), fullPage: true })
  })

  test(`employee-file search stays clear in ${theme} mode`, async ({ page }, testInfo) => {
    await page.goto('/')
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim().length > 0)
    await installWorkbenchFixture(page, theme, 'file')
    await expectSearchIconClear(page, 'Search by name or employee number')
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`document-employee-file-${theme}.png`), fullPage: true })
  })

  test(`recipient search stays clear in ${theme} mode`, async ({ page }, testInfo) => {
    await page.goto('/')
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim().length > 0)
    await installWorkbenchFixture(page, theme, 'send')
    await expectSearchIconClear(page, 'Search employees')
    await expect(page.getByRole('button', { name: 'Send document' })).toBeVisible()
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`document-send-${theme}.png`), fullPage: true })
  })
}
