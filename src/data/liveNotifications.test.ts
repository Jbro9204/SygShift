import { beforeEach, describe, expect, it, vi } from 'vitest'
import { claimNotification, safeNotificationPath } from './liveNotifications'
describe('notification presentation safety', () => {
  beforeEach(() => localStorage.clear())
  it('deduplicates each alert per employee on this device', async () => {
    expect(await claimNotification('one', 'event')).toBe(true)
    expect(await claimNotification('one', 'event')).toBe(false)
    expect(await claimNotification('two', 'event')).toBe(true)
  })
  it('uses the cross-tab lock when available', async () => {
    const request = vi.fn((_key: string, callback: () => boolean) => Promise.resolve(callback()))
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true })
    await Promise.all([claimNotification('one', 'event'), claimNotification('one', 'event')])
    expect(request).toHaveBeenCalledTimes(2)
  })
  it.each(['//outside.example', '/\\outside.example', 'https://outside.example', 'javascript:alert(1)', null])('rejects unsafe destinations: %s', (path) => {
    expect(safeNotificationPath(path)).toBe('/notifications')
  })
  it('keeps safe internal ticket links', () => expect(safeNotificationPath('/support?ticket=123')).toBe('/support?ticket=123'))
})
