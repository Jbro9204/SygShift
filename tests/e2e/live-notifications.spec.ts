import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { createHash } from 'node:crypto'
const fixture = `http://127.0.0.1:${4187 + Number(process.env.PLAYWRIGHT_PORT_OFFSET ?? 0)}/tests/fixtures/live-ui.html`
async function setup(page: Page) {
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.addInitScript(() => {
    Reflect.set(window, 'fixtureSoundCount', 0)
    class AudioContextFixture {
      state = 'running'
      destination = {}
      async resume() {}
      async decodeAudioData() { return {} }
      createBufferSource() { return { buffer: null, connect: (target: unknown) => target, start: () => Reflect.set(window, 'fixtureSoundCount', Reflect.get(window, 'fixtureSoundCount') + 1), stop() {}, disconnect() {}, onended: null } }
      createGain() { return { gain: { value: 1 }, connect: () => ({}), disconnect() {} } }
    }
    Reflect.set(window, 'AudioContext', AudioContextFixture)
  })
}

test('native audio decodes the replacement notification file and unchanged login file', async ({ page }) => {
  // Use the real browser audio engine, isolated data, and local MP3s; no test messages leave the fixture.
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.goto(`${fixture}?scope=${crypto.randomUUID()}`)
  await page.getByText('Sounds & device notifications', { exact: true }).click()
  for (const [kind, asset, hash] of [
    ['notification', 'SygShift_Notification_53571d7e.mp3', '53571d7efae8ce122d8059b3522a237a1a59e2bff2ba6011bf49193c09c0a215'],
    ['login', 'SygShift_Login.mp3', 'f39b512b6b8dbe498283853368513f11211e0a1a3fca38acdcea9de04caf9256'],
  ]) {
    const response = page.waitForResponse((item) => new URL(item.url()).pathname === `/sounds/${asset}`)
    const button = page.getByRole('button', { name: `Test ${kind} sound`, exact: true })
    await button.click()
    const audio = await response
    expect(audio.ok()).toBe(true)
    expect(audio.headers()['content-type']).toContain('audio/mpeg')
    expect(createHash('sha256').update(await audio.body()).digest('hex')).toBe(hash)
    await expect(button).toBeEnabled()
    await expect(page.getByText('Test sound played.', { exact: false })).toBeVisible()
  }
})

test('two roles see live replies and resolved status without losing a draft', async ({ page, context }) => {
  const scope = crypto.randomUUID()
  await setup(page)
  await page.goto(`${fixture}?scope=${scope}`)
  const draft = page.getByRole('textbox', { name: 'Reply to ticket', exact: true })
  await draft.fill('Keep my unsent reply while the handler updates the ticket.')
  const admin = await context.newPage()
  await setup(admin)
  await admin.goto(`${fixture}?scope=${scope}&admin`)
  await admin.getByRole('textbox', { name: 'Reply to ticket', exact: true }).fill('The handler response appears immediately.')
  await admin.getByRole('button', { name: 'Send reply', exact: true }).click()
  await expect(page.locator('.support-message')).toContainText('The handler response appears immediately.')
  await expect(draft).toHaveValue('Keep my unsent reply while the handler updates the ticket.')
  await admin.getByLabel('Add as an internal note').check()
  await admin.getByLabel('Internal note', { exact: true }).fill('Private handler-only content.')
  await admin.getByRole('button', { name: 'Add internal note', exact: true }).click()
  await expect(admin.locator('.support-message').last()).toContainText('Private handler-only content.')
  await expect(page.getByText('Private handler-only content.')).toHaveCount(0)
  await admin.getByRole('region', { name: 'Ticket management' }).getByRole('combobox', { name: 'Status', exact: true }).selectOption('resolved')
  await expect(page.locator('.support-lifecycle [aria-current=step]')).toContainText('Resolved')
  await expect(draft).toHaveValue('Keep my unsent reply while the handler updates the ticket.')
  await admin.close()
})

test('new alert updates bell, popup and sound once; old/repeated alerts stay quiet', async ({ page }) => {
  await setup(page)
  await page.goto(`${fixture}?scope=${crypto.randomUUID()}`)
  await expect(page.getByRole('heading', { name: 'My Support Tickets' })).toBeVisible()
  await page.getByRole('button', { name: 'Repeat same alert' }).click()
  await expect(page.locator('.live-notification')).toHaveCount(1)
  await expect.poll(() => page.evaluate(() => Reflect.get(window, 'fixtureSoundCount'))).toBe(1)
  await page.getByRole('button', { name: 'Repeat same alert' }).click()
  await expect(page.locator('.live-notification')).toHaveCount(1)
  await page.getByRole('button', { name: 'Old fixture alert' }).click()
  await expect(page.locator('.live-notification')).toHaveCount(1)
  expect(await page.evaluate(() => Reflect.get(window, 'fixtureSoundCount'))).toBe(1)
  await page.getByRole('button', { name: 'Hide popup' }).click()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'My Support Tickets' })).toBeVisible()
  await expect(page.locator('.live-notification')).toHaveCount(0)
  expect(await page.evaluate(() => Reflect.get(window, 'fixtureSoundCount'))).toBe(0)
})

for (const theme of ['light', 'dark']) test(`sound preferences are usable and responsive in ${theme}`, async ({ page }, testInfo) => {
  await setup(page)
  await page.goto(`${fixture}?scope=${crypto.randomUUID()}`)
  await page.evaluate((value) => { document.documentElement.dataset.theme = value }, theme)
  await page.getByText('Sounds & device notifications', { exact: true }).click()
  await page.getByRole('checkbox', { name: 'Login sound', exact: true }).uncheck()
  await page.getByRole('checkbox', { name: 'Mute all SygShift sounds' }).check()
  await page.getByRole('button', { name: 'Test notification sound' }).click()
  await expect(page.getByText('Test sound played.', { exact: false })).toBeVisible()
  await expect.poll(() => page.evaluate(() => Reflect.get(window, 'fixtureSoundCount'))).toBe(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  expect((await new AxeBuilder({ page }).include('.notification-preferences').analyze()).violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath(`sound-settings-${theme}.png`), fullPage: true })
  await page.reload()
  await page.getByText('Sounds & device notifications', { exact: true }).click()
  await expect(page.getByRole('checkbox', { name: 'Login sound', exact: true })).not.toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Mute all SygShift sounds' })).toBeChecked()
})

test('a blocked device permission explains the next step without affecting the ticket', async ({ page }) => {
  await setup(page)
  await page.addInitScript(() => { Object.defineProperty(Notification, 'requestPermission', { value: async () => 'denied' }) })
  await page.goto(`${fixture}?scope=${crypto.randomUUID()}`)
  await page.getByText('Sounds & device notifications', { exact: true }).click()
  await page.getByRole('button', { name: 'Enable device notifications' }).click()
  await expect(page.getByRole('alert')).toContainText('Notifications are blocked')
  await expect(page.getByRole('textbox', { name: 'Reply to ticket', exact: true })).toBeEnabled()
})

test('two tabs do not replay the same incoming sound', async ({ page, context }) => {
  const scope = crypto.randomUUID()
  await setup(page); await page.goto(`${fixture}?scope=${scope}`)
  await expect(page.getByRole('heading', { name: 'My Support Tickets' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Reply to ticket', exact: true }).click()
  const second = await context.newPage()
  await setup(second); await second.goto(`${fixture}?scope=${scope}`)
  await expect(second.getByRole('heading', { name: 'My Support Tickets' })).toBeVisible()
  await second.getByRole('textbox', { name: 'Reply to ticket', exact: true }).click()
  await second.getByRole('button', { name: 'Repeat same alert' }).click()
  // Headless pages can both report visible. Either tab may win the shared lock;
  // the invariant is exactly one presentation and sound across both tabs.
  await expect.poll(async () => (await page.locator('.live-notification').count()) + (await second.locator('.live-notification').count())).toBe(1)
  await expect.poll(async () => (await page.evaluate(() => Reflect.get(window, 'fixtureSoundCount'))) + (await second.evaluate(() => Reflect.get(window, 'fixtureSoundCount')))).toBe(1)
  await page.bringToFront()
  await page.getByRole('button', { name: 'Repeat same alert' }).click()
  expect((await page.evaluate(() => Reflect.get(window, 'fixtureSoundCount'))) + (await second.evaluate(() => Reflect.get(window, 'fixtureSoundCount')))).toBe(1)
  await second.close()
})
