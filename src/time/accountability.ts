import type { AccountabilityEvent, AccountabilityWorkspace } from '../data/accountability'

export type AccountabilityDisplayState = 'open' | 'confirmed' | 'protected' | 'corrected' | 'dismissed' | 'voided'

export const accountabilityTypeLabels: Readonly<Record<AccountabilityEvent['eventType'], string>> = {
  called_in_sick: 'Called in sick',
  call_off: 'Call-off',
  vacation: 'Vacation / approved time off',
  no_call_no_show: 'No-call / no-show',
  late_arrival: 'Late arrival',
  early_departure: 'Early departure',
  other: 'Other documented occurrence',
}

export const accountabilityDecisionLabels = {
  confirmed: 'Confirm occurrence',
  excused_protected: 'Mark excused / protected',
  corrected: 'Mark corrected',
  dismissed: 'Dismiss incorrect occurrence',
  voided: 'Void record',
  reopened: 'Reopen for review',
} as const

export function accountabilityDisplayState(event: AccountabilityEvent): AccountabilityDisplayState {
  if (event.status === 'voided') return 'voided'
  if (event.reviewOutcome === 'excused_protected') return 'protected'
  if (event.reviewOutcome === 'confirmed') return 'confirmed'
  if (event.reviewOutcome === 'corrected') return 'corrected'
  if (event.reviewOutcome === 'dismissed') return 'dismissed'
  return 'open'
}

export function isNegativeReliabilityOccurrence(event: AccountabilityEvent): boolean {
  if (event.status === 'voided') return false
  if (event.reviewOutcome !== 'confirmed') return false
  return ['call_off', 'no_call_no_show', 'late_arrival', 'early_departure'].includes(event.eventType)
}

export function summarizeAccountability(events: AccountabilityEvent[]) {
  return events.reduce((summary, event) => {
    const state = accountabilityDisplayState(event)
    summary.total += 1
    summary[state] += 1
    if (isNegativeReliabilityOccurrence(event)) summary.confirmedReliabilityOccurrences += 1
    return summary
  }, {
    total: 0,
    open: 0,
    confirmed: 0,
    protected: 0,
    corrected: 0,
    dismissed: 0,
    voided: 0,
    confirmedReliabilityOccurrences: 0,
  })
}

export interface AccountabilityEmployeeSummary {
  employeeId: string
  employeeName: string
  total: number
  open: number
  confirmed: number
  protected: number
  corrected: number
  dismissed: number
  confirmedReliabilityOccurrences: number
}

export function buildEmployeeAccountabilitySummaries(
  employees: AccountabilityWorkspace['employees'],
  events: AccountabilityEvent[],
): AccountabilityEmployeeSummary[] {
  const eventMap = new Map<string, AccountabilityEvent[]>()
  for (const event of events) {
    const employeeEvents = eventMap.get(event.employeeId) ?? []
    employeeEvents.push(event)
    eventMap.set(event.employeeId, employeeEvents)
  }

  return employees.map((employee) => {
    const summary = summarizeAccountability(eventMap.get(employee.id) ?? [])
    return {
      employeeId: employee.id,
      employeeName: employee.name,
      total: summary.total,
      open: summary.open,
      confirmed: summary.confirmed,
      protected: summary.protected,
      corrected: summary.corrected,
      dismissed: summary.dismissed,
      confirmedReliabilityOccurrences: summary.confirmedReliabilityOccurrences,
    }
  }).filter((employee) => employee.total > 0)
}
