import { expect, test } from '@playwright/test'

const choices = [
  ['Coverage already found', 'Choose the qualified guard who agreed to work this shift.'],
  ['Find an available guard', 'Open the shift and notify eligible Flex guards first.'],
  ['Request patrol review', 'Ask Dispatch to review a one-night patrol fallback.'],
  ['No replacement needed', 'Close the staffing need while preserving the original schedule.'],
]

test('guided absence coverage stays readable and contained on desktop and mobile', async ({ page }, testInfo) => {
  await page.setContent(`
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <main class="page page--requests">
      <dialog class="modal-dialog modal-dialog--coverage-workflow" open role="dialog" aria-labelledby="coverage-title">
        <div class="modal-dialog__heading">
          <div class="modal-dialog__heading-copy">
            <h2 id="coverage-title">Handle an employee absence</h2>
            <p>The original assignment stays in the permanent history.</p>
          </div>
          <button class="modal-close" aria-label="Close dialog">×</button>
        </div>
        <div class="coverage-workflow">
          <ol class="coverage-steps" aria-label="Coverage workflow progress">
            <li class="is-active"><span>✓</span><strong>Review absence</strong></li>
            <li class="is-active"><span>2</span><strong>Choose coverage</strong></li>
            <li><span>3</span><strong>Confirm</strong></li>
          </ol>
          <section class="coverage-panel">
            <fieldset class="coverage-choice-grid">
              <legend>How should this shift be handled?</legend>
              ${choices.map(([label, description], index) => `
                <label class="${index === 1 ? 'is-selected' : ''}">
                  <input ${index === 1 ? 'checked' : ''} name="mode" type="radio">
                  <span aria-hidden="true">○</span>
                  <span><strong>${label}</strong><small>${description}</small></span>
                </label>
              `).join('')}
            </fieldset>
            <div class="coverage-opening-fields">
              <div class="coverage-wave-note"><span aria-hidden="true">!</span><div><strong>Flex-first notification order</strong><p>Eligible Flex guards are notified now. Other eligible guards follow after 10 minutes.</p></div></div>
              <label><span>Opening title</span><input value="Open shift available"></label>
              <label><span>Message to qualified guards</span><textarea>A qualified guard is needed for this opening.</textarea></label>
            </div>
          </section>
          <div class="coverage-workflow__actions">
            <button class="secondary-button">Back</button>
            <button class="primary-action">Continue</button>
          </div>
        </div>
      </dialog>
    </main>
  `)
  await page.addStyleTag({ path: 'src/index.css' })
  await page.addStyleTag({ path: 'src/App.css' })
  await page.locator('.modal-dialog--coverage-workflow').evaluate((element) => {
    const dialog = element as HTMLDialogElement
    dialog.close()
    dialog.showModal()
  })

  const geometry = await page.evaluate(() => {
    const dialog = document.querySelector<HTMLDialogElement>('.modal-dialog--coverage-workflow')!
    const input = document.querySelector<HTMLInputElement>('.coverage-opening-fields input')!
    const textarea = document.querySelector<HTMLTextAreaElement>('.coverage-opening-fields textarea')!
    const actions = document.querySelector<HTMLElement>('.coverage-workflow__actions')!
    const choiceGrid = document.querySelector<HTMLElement>('.coverage-choice-grid')!
    const dialogBox = dialog.getBoundingClientRect()
    const actionBox = actions.getBoundingClientRect()
    return {
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      offenders: Array.from(document.querySelectorAll<HTMLElement>('body *')).flatMap((element) => {
        const box = element.getBoundingClientRect()
        return box.right > window.innerWidth + 1 || box.left < -1
          ? [{ className: element.className, left: Math.round(box.left), right: Math.round(box.right), tag: element.tagName }]
          : []
      }),
      dialogLeft: dialogBox.left,
      dialogRight: dialogBox.right,
      dialogWidth: dialogBox.width,
      dialogBottom: dialogBox.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      actionsBottom: actionBox.bottom,
      actionsPosition: getComputedStyle(actions).position,
      actionsStickyBottom: getComputedStyle(actions).bottom,
      actionsVisible: actionBox.bottom <= window.innerHeight + 1,
      inputFontSize: Number.parseFloat(getComputedStyle(input).fontSize),
      inputRadius: Number.parseFloat(getComputedStyle(input).borderRadius),
      textareaFont: getComputedStyle(textarea).fontFamily.toLowerCase(),
      choiceColumns: getComputedStyle(choiceGrid).gridTemplateColumns.split(' ').filter(Boolean).length,
    }
  })

  expect(geometry.documentOverflow, JSON.stringify(geometry.offenders)).toBeLessThanOrEqual(1)
  expect(geometry.dialogLeft).toBeGreaterThanOrEqual(0)
  expect(geometry.dialogRight).toBeLessThanOrEqual(geometry.viewportWidth + 1)
  expect(geometry.dialogWidth).toBeLessThanOrEqual(geometry.viewportWidth)
  expect(geometry.actionsVisible, JSON.stringify(geometry)).toBe(true)
  expect(geometry.inputFontSize).toBeGreaterThanOrEqual(16)
  expect(geometry.inputRadius).toBeGreaterThanOrEqual(8)
  expect(geometry.textareaFont).not.toContain('monospace')
  if (testInfo.project.name.startsWith('mobile')) expect(geometry.choiceColumns, JSON.stringify(geometry)).toBe(1)
  else expect(geometry.choiceColumns, JSON.stringify(geometry)).toBeGreaterThanOrEqual(2)
  await page.screenshot({ path: testInfo.outputPath('absence-coverage-workflow.png'), fullPage: true })
})
