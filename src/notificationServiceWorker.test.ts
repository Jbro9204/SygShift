// @vitest-environment node
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
const source = readFileSync(new URL('../public/notification-sw.js', import.meta.url), 'utf8')
async function fixture(visible = false, owner: string | null = 'employee') {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>()
  const entries = new Map<string, Response>()
  entries.set('/__sygshift_push_owner', Response.json({ employeeId: owner }))
  const notification = vi.fn(async (_title: string, _options: { data: { employeeId: string; path: string } }) => {})
  const message = vi.fn()
  const openWindow = vi.fn(async () => {})
  const windows = visible ? [{ visibilityState: 'visible', postMessage: message }] : []
  runInNewContext(source, { URL, Response, caches: { open: async () => ({ match: async (key: string) => entries.get(key)?.clone(), put: async (key: string, value: Response) => entries.set(key, value) }) },
    self: { addEventListener: (name: string, callback: (event: Record<string, unknown>) => void) => handlers.set(name, callback), location: { origin: 'https://app.sygilant.us' }, clients: { matchAll: async () => windows, openWindow }, registration: { showNotification: notification } },
  })
  async function push(id = 'alert', employeeId = 'employee', path = '/support?ticket=fixture') {
    let completion: Promise<void> | undefined
    handlers.get('push')!({ data: { json: () => ({ id, employeeId, path }) }, waitUntil: (work: Promise<void>) => { completion = work } })
    await completion
  }
  async function click(data: { employeeId: string; path: string }) {
    let completion: Promise<void> | undefined
    handlers.get('notificationclick')!({
      notification: { close: vi.fn(), data },
      waitUntil: (work: Promise<void>) => { completion = work },
    })
    await completion
  }
  return { push, click, notification, message, handlers, openWindow }
}
describe('push-only service worker', () => {
  it('does not intercept normal app or authentication fetches', async () => expect((await fixture()).handlers.has('fetch')).toBe(false))
  it('displays a private generic background alert once', async () => {
    const app = await fixture()
    await app.push(); await app.push()
    expect(app.notification).toHaveBeenCalledTimes(1)
    expect(app.notification).toHaveBeenCalledWith('SygShift update', expect.objectContaining({ body: 'You have a new update. Open SygShift to review it securely.', renotify: false }))
  })
  it('routes foreground alerts into the existing in-app dedup path', async () => {
    const app = await fixture(true)
    await app.push()
    expect(app.notification).not.toHaveBeenCalled()
    expect(app.message).toHaveBeenCalledWith({ type: 'sygshift:notification', id: 'alert' })
  })
  it('suppresses signed-out and previous-account alerts', async () => {
    const signedOut = await fixture(false, null); await signedOut.push(); expect(signedOut.notification).not.toHaveBeenCalled()
    const other = await fixture(false, 'someoneelse'); await other.push(); expect(other.notification).not.toHaveBeenCalled()
  })
  it('replaces unsafe push links with the personal notification inbox', async () => {
    const app = await fixture(); await app.push('alert', 'employee', '//outside.example')
    expect(app.notification).toHaveBeenCalledWith('SygShift update', expect.objectContaining({ data: { path: '/notifications', employeeId: 'employee' } }))
  })
  it.each([
    '/dispatch?call=not-a-uuid',
    '/daily-activity-reports?report=eacdc293-e7ff-4d14-8f8e-38340e26a2c5&edit=true',
    '/incident-reports',
    '/vehicle-inspections?report=not-a-uuid',
  ])('fails a malformed cross-platform push path closed to the notification inbox: %s', async (path) => {
    const app = await fixture()
    await app.push('alert', 'employee', path)
    expect(app.notification).toHaveBeenCalledWith('SygShift update', expect.objectContaining({
      data: { path: '/notifications', employeeId: 'employee' },
    }))
  })
  it.each([
    '/dispatch?call=4896f7c0-7143-48f9-9978-d1f6a342186f',
    '/daily-activity-reports?report=eacdc293-e7ff-4d14-8f8e-38340e26a2c5',
    '/incident-reports?report=eacdc293-e7ff-4d14-8f8e-38340e26a2c5',
    '/vehicle-inspections?report=eacdc293-e7ff-4d14-8f8e-38340e26a2c5',
  ])('bridges a background %s click through the signed Sygilant launch page', async (destination) => {
    const app = await fixture()
    await app.push('2768b3c0-6f71-4ba0-8795-6cd965871a97', 'employee', destination)
    const data = app.notification.mock.calls[0]?.[1]?.data
    expect(data).toEqual({
      employeeId: 'employee',
      path: `/notifications?sygilant=${encodeURIComponent(destination)}&notification=2768b3c0-6f71-4ba0-8795-6cd965871a97`,
    })

    await app.click(data)
    expect(app.openWindow).toHaveBeenCalledWith(`https://app.sygilant.us${data.path}`)
  })
  it('does not repeat an alert already presented in the app', async () => {
    const app = await fixture()
    let completion: Promise<void> | undefined
    app.handlers.get('message')!({ data: { type: 'sygshift:push-presented', employeeId: 'employee', id: 'alert' }, ports: [], waitUntil: (work: Promise<void>) => { completion = work } })
    await completion
    await app.push()
    expect(app.notification).not.toHaveBeenCalled()
  })
  it('honors muted background notifications', async () => {
    const app = await fixture()
    let completion: Promise<void> | undefined
    app.handlers.get('message')!({ data: { type: 'sygshift:push-sound', muted: true }, ports: [], waitUntil: (work: Promise<void>) => { completion = work } })
    await completion
    await app.push()
    expect(app.notification).toHaveBeenCalledWith('SygShift update', expect.objectContaining({ silent: true }))
  })
})
