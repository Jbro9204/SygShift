import { describe, expect, it } from 'vitest'
import { supportLifecycle, supportStatusLabels } from './lib/supportLifecycle'

describe('support lifecycle presentation', () => {
  it('keeps every existing non-Closed status', () => {
    expect(Object.keys(supportStatusLabels)).toEqual(['new', 'assigned', 'in_progress', 'waiting_on_employee', 'resolved', 'reopened'])
  })
  it.each(Object.keys(supportStatusLabels) as Array<keyof typeof supportStatusLabels>)('highlights the real %s status and explains next action', (status) => {
    const lifecycle = supportLifecycle(status)
    expect(lifecycle.labels[lifecycle.current]).toBe(supportStatusLabels[status])
    expect(lifecycle.next.length).toBeGreaterThan(20)
  })
  it('treats waiting and reopening as branches, not completion', () => {
    expect(supportLifecycle('waiting_on_employee').current).toBe(2)
    expect(supportLifecycle('reopened').current).toBe(1)
    expect(supportLifecycle('resolved').current).toBe(3)
  })
})
