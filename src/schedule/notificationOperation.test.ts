// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  abandonUnstartedScheduleNotificationOperation,
  acquireScheduleNotificationOperation,
  completeScheduleNotificationOperation,
  markScheduleNotificationOperationStarted,
} from './notificationOperation'

const ownerId = '10000000-0000-4000-8000-000000000001'
const scheduleId = '20000000-0000-4000-8000-000000000001'
const weekStartsOn = '2026-10-18'
const firstOperationId = '30000000-0000-4000-8000-000000000001'
const secondOperationId = '30000000-0000-4000-8000-000000000002'

describe('schedule notification operation identity', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  it('reuses the same persisted operation after an attempted response is lost', () => {
    const first = acquireScheduleNotificationOperation(ownerId, scheduleId, weekStartsOn, () => firstOperationId)
    markScheduleNotificationOperationStarted(ownerId, scheduleId, weekStartsOn, first.operationId)

    // A later render/retry (including one across a minute boundary) must not
    // derive another identity from wall-clock time.
    const retry = acquireScheduleNotificationOperation(ownerId, scheduleId, weekStartsOn, () => secondOperationId)

    expect(retry).toEqual({
      attempted: true,
      operationId: firstOperationId,
      ownerEmployeeId: ownerId,
      scheduleId,
      weekStartsOn,
    })
  })

  it('creates an explicit new identity only after verified completion', () => {
    const first = acquireScheduleNotificationOperation(ownerId, scheduleId, weekStartsOn, () => firstOperationId)
    markScheduleNotificationOperationStarted(ownerId, scheduleId, weekStartsOn, first.operationId)
    completeScheduleNotificationOperation(ownerId, scheduleId, weekStartsOn, first.operationId)

    const deliberateResend = acquireScheduleNotificationOperation(ownerId, scheduleId, weekStartsOn, () => secondOperationId)

    expect(deliberateResend.operationId).toBe(secondOperationId)
    expect(deliberateResend.attempted).toBe(false)
  })

  it('abandons a cancelled dialog only before any queue request begins', () => {
    const unstarted = acquireScheduleNotificationOperation(ownerId, scheduleId, weekStartsOn, () => firstOperationId)
    abandonUnstartedScheduleNotificationOperation(ownerId, scheduleId, weekStartsOn, unstarted.operationId)
    expect(acquireScheduleNotificationOperation(ownerId, scheduleId, weekStartsOn, () => secondOperationId).operationId).toBe(secondOperationId)

    const startedScheduleId = '20000000-0000-4000-8000-000000000002'
    const started = acquireScheduleNotificationOperation(ownerId, startedScheduleId, weekStartsOn, () => firstOperationId)
    markScheduleNotificationOperationStarted(ownerId, startedScheduleId, weekStartsOn, started.operationId)
    abandonUnstartedScheduleNotificationOperation(ownerId, startedScheduleId, weekStartsOn, started.operationId)
    expect(acquireScheduleNotificationOperation(ownerId, startedScheduleId, weekStartsOn, () => secondOperationId).operationId).toBe(firstOperationId)
  })

  it('keeps operation identity scoped to both employee and schedule', () => {
    const first = acquireScheduleNotificationOperation(ownerId, scheduleId, weekStartsOn, () => firstOperationId)
    const otherOwner = acquireScheduleNotificationOperation(
      '10000000-0000-4000-8000-000000000002',
      scheduleId,
      weekStartsOn,
      () => secondOperationId,
    )

    expect(first.operationId).toBe(firstOperationId)
    expect(otherOwner.operationId).toBe(secondOperationId)
  })

  it('keeps the in-memory retry identity when sessionStorage cannot persist it', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('storage unavailable')
    })

    const first = acquireScheduleNotificationOperation(ownerId, scheduleId, weekStartsOn, () => firstOperationId)
    const retry = acquireScheduleNotificationOperation(ownerId, scheduleId, weekStartsOn, () => secondOperationId)

    expect(retry.operationId).toBe(first.operationId)
    setItem.mockRestore()
  })

  it('rejects a persisted identity bound to a different week', () => {
    acquireScheduleNotificationOperation(ownerId, scheduleId, weekStartsOn, () => firstOperationId)

    const rebound = acquireScheduleNotificationOperation(ownerId, scheduleId, '2026-10-25', () => secondOperationId)

    expect(rebound.operationId).toBe(secondOperationId)
    expect(rebound.weekStartsOn).toBe('2026-10-25')
  })
})
