const safeTimeOffErrorMessages: ReadonlyArray<{ match: string; message: string }> = [
  {
    match: 'already overlaps',
    message: 'You already have an active time-off request that overlaps this time. Review that request before submitting another one.',
  },
  {
    match: 'current or imminent shift',
    message: 'This request includes a current or imminent shift. Use Report Sick / Call-Off so Dispatch is notified immediately.',
  },
  {
    match: 'mfa is required',
    message: 'Confirm your identity with MFA, then try the review again. Your decision note has been kept.',
  },
  {
    match: 'another authorized reviewer',
    message: 'A different authorized reviewer must decide your own time-off request. Your decision was not saved.',
  },
  {
    match: 'resolve assigned shifts',
    message: 'Resolve the affected assigned shifts before approving this time off. You can keep this request pending or decline it with a note.',
  },
  {
    match: 'no longer pending',
    message: 'This request has already been updated. Refresh the request to see its current status.',
  },
  {
    match: 'valid time-off date range',
    message: 'Choose a valid first and last day for this request.',
  },
  {
    match: 'cannot begin in the past',
    message: 'Time off cannot begin in the past. Choose today or a future date.',
  },
  {
    match: 'cannot exceed 367 calendar days',
    message: 'A single request cannot cover more than 367 calendar days. Shorten the date range and try again.',
  },
  {
    match: 'return date cannot be before',
    message: 'Choose an expected return date on or after the final requested date.',
  },
  {
    match: 'partial-day times require',
    message: 'For a partial day, choose one date and an end time later than the start time.',
  },
  {
    match: 'daylight-saving clock change',
    message: 'Choose partial-day times outside the daylight-saving clock change, then try again.',
  },
  {
    match: 'paid vacation is available only to salary employees',
    message: 'Paid Vacation is available only to salary employees. Choose another request type to continue.',
  },
]

export function timeOffErrorMessage(error: unknown, fallback: string): string {
  const rawMessage = error instanceof Error ? error.message.toLowerCase() : ''
  return safeTimeOffErrorMessages.find(({ match }) => rawMessage.includes(match))?.message ?? fallback
}
