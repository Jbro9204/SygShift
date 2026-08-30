import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  completeHrAutomationTask,
  getHrAutomationWorkspace,
  getMyHrAutomationTasks,
} from './hrAutomation'

vi.mock('./hrDocuments', () => ({
  documentApiHeaders: vi.fn(async () => ({ Authorization: 'Bearer test-token', 'Content-Type': 'application/json' })),
  parseApiError: vi.fn(async (_response: Response, fallback: string) => new Error(fallback)),
}))

const taskId = '11111111-1111-4111-8111-111111111111'

describe('HR automation API client', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => vi.unstubAllGlobals())

  it('accepts the safely disabled personal action response', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ enabled: false, total: 0, tasks: [] }), { status: 200 }))
    await expect(getMyHrAutomationTasks()).resolves.toEqual({ enabled: false, total: 0, tasks: [] })
  })

  it('requests a bounded administrative workspace page', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      enabled: false,
      pageSize: 10,
      offset: 20,
      definitions: [],
      instances: [],
      tasks: [],
      deadLetters: [],
      counts: { definitions: 0, activeInstances: 0, openTasks: 0, deadLetters: 0 },
    }), { status: 200 }))
    await getHrAutomationWorkspace(10, 20)
    expect(fetch).toHaveBeenCalledWith('/api/v1/hr/automation/workspace?pageSize=10&offset=20', expect.objectContaining({ cache: 'no-store' }))
  })

  it('sends the required completion note without mutating the task payload', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ taskId, status: 'completed' }), { status: 200 }))
    await completeHrAutomationTask(taskId, 'Employment verification reviewed and completed.')
    expect(fetch).toHaveBeenCalledWith(`/api/v1/hr/automation/tasks/${taskId}/complete`, expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ note: 'Employment verification reviewed and completed.' }),
    }))
  })
})
