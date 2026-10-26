import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  normalizeBaselinePayload,
  normalizeCandidatePayload,
  validateDateRange,
  validatePreviewPerformance,
} from './validate-timekeeping-review-preview.mjs'

test('normalizes only the intentional v2 classification envelope', () => {
  const baseline = {
    serverTimestamp: 'first',
    rows: [{ employeeId: 'one', paidMinutes: 60 }],
    summary: { paidMinutes: 60 },
  }
  const candidate = {
    ...baseline,
    reviewContractVersion: 'timekeeping-review-v2',
    serverTimestamp: 'second',
    rows: [{
      ...baseline.rows[0],
      mixedWorkTypes: false,
      payCode: 'REG',
      workType: 'post',
      workTypeLabel: 'Worked Time',
      workTypeOvertimeEligible: true,
      workTypePaid: true,
      workTypeRateSource: 'employee_base_rate',
    }],
  }
  assert.deepEqual(normalizeCandidatePayload(candidate), normalizeBaselinePayload(baseline))
  assert.equal(candidate.rows[0].workType, 'post')
})

test('rejects invalid, reversed and oversized preview ranges', () => {
  for (const [fromDate, throughDate] of [
    ['2026-02-30', '2026-03-01'],
    ['2026-10-18', '2026-10-17'],
    ['2026-09-01', '2026-10-17'],
  ]) assert.throws(() => validateDateRange(fromDate, throughDate), /valid/)
})

test('runs candidate-first, baseline-first, repeated and concurrent read-only requests', async () => {
  const calls = []
  const base = { serverTimestamp: 'changing', rows: [], summary: { paidMinutes: 0 } }
  const candidate = { ...base, reviewContractVersion: 'timekeeping-review-v2' }
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    return {
      json: async () => url.endsWith('get_timekeeping_review_v2') ? candidate : base,
      ok: true,
      status: 200,
    }
  }

  const result = await validatePreviewPerformance({
    accessToken: 'test-token',
    anonKey: 'test-key',
    concurrency: 3,
    fetchImpl,
    fromDate: '2026-10-04',
    previewUrl: 'https://preview.example.test',
    repeat: 2,
    throughDate: '2026-10-17',
  })

  assert.equal(calls.length, 9)
  assert.match(calls[0].url, /get_timekeeping_review_v2$/)
  assert.match(calls[1].url, /get_timekeeping_review$/)
  assert.match(calls[2].url, /get_timekeeping_review$/)
  assert.match(calls[3].url, /get_timekeeping_review_v2$/)
  assert.ok(calls.every((call) => call.options.method === 'POST'))
  assert.ok(calls.every((call) => !/test-token|test-key/.test(call.url)))
  assert.equal(result.durations.concurrentCandidate.length, 3)
})
