import { expect, test } from '@playwright/test'

const fixture = `http://127.0.0.1:${4188 + Number(process.env.PLAYWRIGHT_PORT_OFFSET ?? 0)}/tests/fixtures/notification-ui.html`
const statuses = ['queued', 'delivered', 'failed', 'suppressed', 'canceled', 'retry_exhausted'] as const

test('delivery operations distinguish terminal outcomes and preserve authorized retry', async ({ page }, testInfo) => {
  let retried = false
  let versionedReads = 0
  let legacyReads = 0
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.route('**/fixture-notifications/inbox', (route) => route.fulfill({ json: {
    summary: { unread: 0, requiresAction: 0, urgent: 0 }, permissions: { canSend: false, canManageDelivery: true },
    page: { number: 1, size: 10, total: 0, totalPages: 1 }, notifications: [],
  } }))
  await page.route('**/fixture-notifications/rpc/get_notification_center', (route) => {
    legacyReads += 1
    return route.fulfill({ status: 409, json: { message: 'New clients must explicitly select the versioned reader.' } })
  })
  await page.route('**/fixture-notifications/rpc/get_notification_center_v2', (route) => {
    versionedReads += 1
    const status = route.request().postDataJSON().target_status
    const batches = statuses.map((value, index) => ({
      id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      messageType: 'schedule_published', aggregateType: 'announcement', aggregateId: null,
      subject: `${value} delivery fixture`, status: value === 'retry_exhausted' && retried ? 'queued' : value,
      recipientCount: 1, attemptCount: value === 'retry_exhausted' ? 5 : 1,
      availableAt: '2026-10-19T23:00:00Z', createdAt: '2026-10-19T23:00:00Z',
      deliveredAt: value === 'delivered' ? '2026-10-19T23:00:00Z' : null,
      failedAt: ['failed', 'suppressed', 'canceled', 'retry_exhausted'].includes(value) ? '2026-10-19T23:00:00Z' : null,
      lastError: value === 'suppressed' ? 'Suppressed — Provider Recipient' : null, channels: ['Email'],
    })).filter((batch) => status === 'all' || batch.status === status)
    return route.fulfill({ json: {
      permissions: { canManage: true }, summary: { pending: retried ? 2 : 1, delivered: 1, failed: 1, suppressed: 1, canceled: 1, retryExhausted: retried ? 0 : 1 },
      page: { number: 1, size: 10, total: batches.length, totalPages: 1 }, batches,
    } })
  })
  await page.route('**/fixture-notifications/rpc/retry_notification_job', (route) => {
    retried = true
    return route.fulfill({ json: { retried: 1 } })
  })
  await page.goto(fixture)
  await page.getByRole('button', { name: 'Delivery Operations', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Email delivery history' })).toBeVisible()
  await expect(page.locator('.communications-summary article')).toHaveCount(6)
  for (const status of ['suppressed', 'canceled']) {
    await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption(status)
    await expect(page.getByText(`${status} delivery fixture`, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'View details', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retry this job', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Close', exact: true }).click()
  }
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('retry_exhausted')
  await expect(page.getByText('retry_exhausted delivery fixture', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'View details', exact: true }).click()
  await page.getByRole('button', { name: 'Retry this job', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('status')).toContainText('Queued 1 retry.')
  await expect(page.getByRole('heading', { name: 'No delivery jobs match' })).toBeVisible()
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('all')
  await expect(page.getByText('suppressed delivery fixture', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(versionedReads).toBeGreaterThan(0)
  expect(legacyReads).toBe(0)
  await page.screenshot({ path: testInfo.outputPath('delivery-terminal-states.png'), fullPage: true })
})

test('forward reader recovery clearly discloses coarse delivery visibility', async ({ page }, testInfo) => {
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.route('**/fixture-notifications/inbox', (route) => route.fulfill({ json: {
    summary: { unread: 0, requiresAction: 0, urgent: 0 }, permissions: { canSend: false, canManageDelivery: true },
    page: { number: 1, size: 10, total: 0, totalPages: 1 }, notifications: [],
  } }))
  await page.route('**/fixture-notifications/rpc/get_notification_center_v2', (route) => {
    const visible = ['all', 'failed'].includes(route.request().postDataJSON().target_status)
    return route.fulfill({ json: {
      deliveryVisibility: 'legacy', permissions: { canManage: true }, summary: { pending: 0, delivered: 0, failed: 1 },
      page: { number: 1, size: 10, total: visible ? 1 : 0, totalPages: 1 },
      batches: visible ? [{
        id: '10000000-0000-4000-8000-000000000001', messageType: 'schedule_published', aggregateType: 'announcement',
        aggregateId: null, subject: 'Coarse history fixture', status: 'failed', recipientCount: 1, attemptCount: 1,
        availableAt: '2026-10-19T23:00:00Z', createdAt: '2026-10-19T23:00:00Z', deliveredAt: null,
        failedAt: '2026-10-19T23:00:00Z', lastError: null, channels: ['Email'],
      }] : [],
    } })
  })
  await page.goto(fixture)
  await page.getByRole('button', { name: 'Delivery Operations', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Detailed terminal statuses are temporarily unavailable.')
  await expect(page.getByText('Coarse history fixture', { exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('suppressed')
  await expect(page.getByRole('heading', { name: 'No delivery jobs match' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('delivery-reader-recovery.png'), fullPage: true })
})
