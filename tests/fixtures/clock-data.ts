// Real components and data parsers; isolated RPC transport. Never uses live accounts.
export const isSupabaseConfigured = true
// The fixture client is already isolated; shared-session switching is intentionally a no-op.
export async function activateSharedIdentitySupabaseSession(_accessToken: string, _refreshToken: string) {}
export function deactivateSharedIdentitySupabaseSession() {}
const params = new URLSearchParams(location.search)
const scenario = params.get('scenario') ?? 'early'
const employeeId = '10000000-0000-4000-8000-000000000001'
const shiftId = '20000000-0000-4000-8000-000000000001'
const serverTimestamp = '2026-09-06T16:00:00Z'
const startsAt = scenario === 'ready' || scenario === 'multiple' ? '2026-09-06T16:05:00Z' : '2026-09-07T20:00:00Z'
const shift = { assignmentId: shiftId, shiftId, status: 'assigned', startsAt, endsAt: '2026-09-08T00:00:00Z', timeZone: 'America/Denver', requiresArmed: false, isOvertime: false, assignmentType: 'standard', postName: 'Front desk', siteName: 'Test site', siteCode: 'TEST', eventName: null, locationName: 'Test site' }
let lastEvent: null | { id: string; kind: string; shiftId: string; recordedAt: string; source: string } = scenario === 'working' || scenario === 'break'
  ? { id: employeeId, kind: scenario === 'break' ? 'break_start' : 'clock_in', shiftId, recordedAt: serverTimestamp, source: 'web' } : null
let attempts = 0
let punches = 0
let dashboardCalls = 0
const delay = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms))
export function getSupabaseClient() {
  return {
    async rpc(name: string, input?: { target_kind?: string }) {
      await delay()
      if (name === 'get_session_context') return { error: null, data: { employee_id: employeeId, username: 'testemployee', display_name: 'Test Employee', role: params.get('role') ?? 'guard', must_change_password: false, password_changed_at: null, mfa_enrolled_at: null, mfa_required: false, has_mfa: false, time_zone: 'America/New_York', permissions: params.has('viewonly') ? ['time.self.view'] : ['time.self.view', 'time.punch'] } }
      if (name === 'get_timekeeping_dashboard') {
        dashboardCalls++
        if (scenario === 'loading') await delay(1000)
        if (scenario === 'error' && dashboardCalls === 1) return { data: null, error: { message: 'Fixture connection failure' } }
        return { error: null, data: { serverTimestamp, operationalDate: '2026-09-06', operationalTimeZone: 'America/Denver', employee: { id: employeeId, username: 'testemployee', displayName: 'Test Employee', role: params.get('role') ?? 'guard', employmentType: 'hourly', timeZone: 'America/New_York' }, lastEvent, eligibleShifts: ['empty', 'no-assignment', 'working', 'break'].includes(scenario) ? [] : scenario === 'multiple' ? [shift, { ...shift, shiftId: '20000000-0000-4000-8000-000000000002', assignmentId: '20000000-0000-4000-8000-000000000002', postName: 'Other post' }] : [shift], recentEvents: lastEvent ? [lastEvent] : [], pendingCorrectionCount: 0 } }
      }
      if (name === 'record_time_event') {
        attempts++
        const displayCounts = () => { document.getElementById('clock-fixture-records')!.textContent = `${attempts} attempts · ${punches} punches` }
        displayCounts()
        if (input?.target_kind === 'clock_in' && !['ready', 'multiple'].includes(scenario)) {
          if (scenario === 'no-assignment') return { data: null, error: { message: 'No active published shift is assigned for clock-in. Open your schedule or contact your supervisor.' } }
          return { error: null, data: { status: 'blocked', code: 'EARLY_CLOCK_IN_BLOCKED', trustedServerTime: serverTimestamp, scheduledShiftStart: startsAt, scheduledShiftEnd: shift.endsAt, clockInEligibleAt: '2026-09-07T19:55:00Z', shiftDate: '2026-09-07', shiftDisplayName: 'Front desk', siteCode: 'TEST', siteName: 'Test site', postName: 'Front desk', locationName: 'Test site', coverageType: 'Unarmed coverage', timeZone: 'America/Denver', employeeTimeZone: 'America/New_York', clockInWindowMinutes: 5 } }
        }
        punches++
        lastEvent = { id: `${employeeId.slice(0, -1)}${punches}`, kind: input!.target_kind!, shiftId, recordedAt: serverTimestamp, source: 'web' }
        displayCounts()
        return { data: lastEvent, error: null }
      }
      return { data: null, error: { message: 'This unrelated fixture workspace is not connected.' } }
    },
  }
}
