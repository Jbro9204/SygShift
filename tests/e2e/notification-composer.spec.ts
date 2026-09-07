import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const fixture = `http://127.0.0.1:${4188 + Number(process.env.PLAYWRIGHT_PORT_OFFSET ?? 0)}/tests/fixtures/notification-ui.html`
const employees = Array.from({ length: 14 }, (_, index) => ({
  id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  name: index === 0 ? 'Alex Employee' : `Employee ${index + 1}`,
  title: index === 1 ? 'Recruiting, Licensing and Employee Development Coordinator' : 'Guard',
  role: 'guard',
}))
const roles = [
  { code: 'guard', label: 'Guard', count: 14 },
  { code: 'recruiting_licensing', label: 'Recruiting Licensing', count: 1 },
  { code: 'scheduler', label: 'Scheduler', count: 1 },
  { code: 'supervisor', label: 'Supervisor', count: 4 },
]
async function setup(page: Page, { canSend = true, canSendEveryone = true, optionsStatus = 200 } = {}) {
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.route('**/fixture-notifications/inbox', (route) => route.fulfill({ json: {
    summary: { unread: 0, requiresAction: 0, urgent: 0 }, permissions: { canSend, canManageDelivery: false },
    page: { number: 1, size: 10, total: 0, totalPages: 1 }, notifications: [],
  } }))
  await page.route('**/fixture-notifications/options?*', (route) => {
    const search = new URL(route.request().url()).searchParams.get('search') || ''
    return route.fulfill({ status: optionsStatus, json: { canSendEveryone, roles, employees: employees.filter((employee) => employee.name.toLowerCase().includes(search.toLowerCase())) } })
  })
  await page.route('**/fixture-notifications/send', (route) => route.fulfill({ json: { campaignId: crypto.randomUUID(), recipientCount: 1, emailEnabled: route.request().postDataJSON().emailEnabled } }))
  await page.goto(fixture)
}

async function fillMessage(page: Page) {
  await page.getByRole('checkbox', { name: 'Alex Employee' }).check()
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Upcoming team schedule')
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Please review your upcoming schedule and let us know if you need help.\nThank you!')
}

for (const theme of ['light', 'dark']) test(`composer controls, cushioning and checkbox alignment in ${theme}`, async ({ page }, testInfo) => {
  const widths = testInfo.project.name.startsWith('mobile') ? [390, 320] : [1440, 1024]
  await setup(page)
  await page.evaluate((value) => { document.documentElement.dataset.theme = value }, theme)
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 })
    await expect(page.getByRole('heading', { name: 'Send a notification', exact: true })).toBeVisible()
    const controls = await page.locator('.notification-composer input:not([type=checkbox]), .notification-composer select, .notification-composer textarea').evaluateAll((elements) => elements.map((element) => {
      const style = getComputedStyle(element)
      return { height: element.getBoundingClientRect().height, radius: parseFloat(style.borderRadius), padding: parseFloat(style.paddingLeft), font: style.fontFamily, weight: style.fontWeight, fontSize: parseFloat(style.fontSize) }
    }))
    expect(controls).toHaveLength(6)
    for (const control of controls) {
      expect(control.height).toBeGreaterThanOrEqual(44)
      expect(control.radius).toBeGreaterThanOrEqual(10)
      expect(control.padding).toBeGreaterThanOrEqual(12)
      expect(control.font).not.toMatch(/monospace/i)
      expect(control.weight).toBe('400')
      expect(control.fontSize).toBeGreaterThanOrEqual(16)
    }
    const gaps = await page.locator('.notification-delivery-options label').evaluateAll((labels) => labels.map((label) => {
      const input = label.querySelector('input')!.getBoundingClientRect()
      const text = label.querySelector('span')!.getBoundingClientRect()
      const card = label.getBoundingClientRect()
      return { width: input.width, gap: text.left - input.right, inset: input.left - card.left, rowHeight: card.height }
    }))
    for (const item of gaps) {
      expect(item.width).toBe(18)
      expect(item.gap).toBeGreaterThanOrEqual(10)
      expect(item.gap).toBeLessThanOrEqual(14)
      expect(item.inset).toBeGreaterThanOrEqual(12)
      expect(item.rowHeight).toBeGreaterThanOrEqual(56)
    }
    const containment = await page.locator('.notification-composer').evaluate((form) => {
      const bounds = form.getBoundingClientRect()
      const audience = form.querySelector('.notification-audience')!.getBoundingClientRect()
      const title = form.querySelector('.notification-compose-fields input')!.getBoundingClientRect()
      const button = form.querySelector('.notification-compose-actions button')!.getBoundingClientRect()
      return { aligned: Math.abs(audience.left - title.left), gutter: title.left - bounds.left, buttonInside: button.left >= bounds.left && button.right <= bounds.right, overflow: document.documentElement.scrollWidth - innerWidth }
    })
    expect(containment.aligned).toBeLessThanOrEqual(1)
    expect(containment.gutter).toBeGreaterThanOrEqual(16)
    expect(containment.buttonInside).toBe(true)
    expect(containment.overflow).toBeLessThanOrEqual(1)
    const recipientLayout = await page.locator('.notification-audience').evaluate((audience) => {
      const search = audience.querySelector('.notification-recipient-search input')!
      const input = search.getBoundingClientRect()
      const icon = audience.querySelector('.notification-recipient-search svg')!.getBoundingClientRect()
      const rows = [...audience.querySelectorAll('.notification-employee-picker label')]
      return {
        iconGap: input.left + parseFloat(getComputedStyle(search).paddingLeft) - icon.right,
        overflowingRows: rows.filter((row) => row.querySelector('span')!.getBoundingClientRect().bottom > row.getBoundingClientRect().bottom - 10).length,
      }
    })
    expect(recipientLayout.iconGap).toBeGreaterThanOrEqual(8)
    expect(recipientLayout.overflowingRows).toBe(0)
    await page.screenshot({ path: testInfo.outputPath(`composer-${theme}-${width}.png`), fullPage: true })
  }
  expect((await new AxeBuilder({ page }).include('.notification-composer').analyze()).violations).toEqual([])
  const title = page.getByRole('textbox', { name: 'Title', exact: true })
  await title.focus()
  await expect(title).toHaveCSS('outline-style', 'solid')
  await expect(title).toHaveCSS('outline-width', '2px')
})

test('recipient selection, search, review, and delivery options preserve the outgoing payload', async ({ page }) => {
  await setup(page)
  const review = page.getByRole('button', { name: 'Review notification', exact: true })
  await expect(review).toBeDisabled()
  await fillMessage(page)
  const selected = page.locator('.notification-employee-picker label').first()
  const selectedBackground = await selected.evaluate((element) => getComputedStyle(element).backgroundColor)
  expect(selectedBackground).not.toBe('rgba(0, 0, 0, 0)')
  await page.getByRole('textbox', { name: 'Find individual employees' }).fill('Alex')
  await expect(page.locator('.notification-employee-picker label')).toHaveCount(1)
  await expect(page.getByRole('checkbox', { name: 'Alex Employee' })).toBeChecked()
  await page.getByRole('combobox', { name: 'Priority', exact: true }).selectOption('important')
  await page.getByRole('checkbox', { name: 'Also send by email' }).uncheck()
  await page.getByRole('checkbox', { name: 'Require acknowledgment' }).check()
  await page.getByRole('textbox', { name: 'Related SygShift path' }).fill('/schedule')
  await page.getByRole('textbox', { name: 'Action-button label' }).fill('Review schedule')
  const sent: unknown[] = []
  page.on('request', (request) => { if (request.url().endsWith('/fixture-notifications/send')) sent.push(request.postDataJSON()) })
  await review.click()
  await expect(page.getByRole('heading', { name: 'Review before sending' })).toBeVisible()
  expect(sent).toHaveLength(0)
  await expect(page.locator('.notification-review')).toContainText('In SygShift only')
  await page.getByRole('button', { name: 'Edit notification' }).click()
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(/Please review your upcoming schedule/)
  await review.click()
  await page.getByRole('button', { name: 'Confirm and send' }).click()
  await expect(page.getByRole('heading', { name: 'Delivered to 1 SygShift inbox' })).toBeVisible()
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ employeeIds: [employees[0].id], roles: [], everyone: false, priority: 'important', requiresAcknowledgement: true, emailEnabled: false, actionPath: '/schedule', actionLabel: 'Review schedule' })
})

test('pending and failed delivery retain the draft and block duplicate submission', async ({ page }) => {
  await setup(page)
  let finish: (() => void) | undefined
  const hold = new Promise<void>((resolve) => { finish = resolve })
  await page.route('**/fixture-notifications/send', async (route) => { await hold; await route.fulfill({ status: 503, json: {} }) })
  await fillMessage(page)
  await page.getByRole('button', { name: 'Review notification' }).click()
  await page.getByRole('button', { name: 'Confirm and send' }).click()
  await expect(page.getByRole('button', { name: 'Sending…' })).toBeDisabled()
  finish!()
  await expect(page.getByRole('alert')).toContainText('Unable to complete this request')
  await page.getByRole('button', { name: 'Edit notification' }).click()
  await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Upcoming team schedule')
  await expect(page.getByRole('checkbox', { name: 'Alex Employee' })).toBeChecked()
})

test('company-wide selection and permission-denied states stay bounded', async ({ page }) => {
  await setup(page)
  await page.getByRole('checkbox', { name: 'Every active employee' }).check()
  await expect(page.locator('.notification-role-grid input').first()).toBeDisabled()
  await expect(page.getByRole('textbox', { name: 'Find individual employees' })).toBeDisabled()
  await page.getByRole('checkbox', { name: 'Every active employee' }).uncheck()
  await expect(page.locator('.notification-role-grid input').first()).toBeEnabled()
  await setup(page, { canSendEveryone: false })
  await expect(page.getByRole('heading', { name: 'Send a notification', exact: true })).toBeVisible()
  await expect(page.getByRole('checkbox', { name: 'Every active employee' })).toHaveCount(0)
  await setup(page, { optionsStatus: 403 })
  await expect(page.getByRole('heading', { name: 'Recipient access unavailable' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveCount(0)
  await setup(page, { canSend: false })
  await expect(page.getByRole('heading', { name: 'No notifications match' })).toBeVisible()
  await expect(page.locator('.notification-composer')).toHaveCount(0)
})
