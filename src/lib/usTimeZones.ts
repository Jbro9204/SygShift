export const continentalUsTimeZones = [
  { label: 'Eastern Time', shortLabel: 'Eastern', value: 'America/New_York' },
  { label: 'Central Time', shortLabel: 'Central', value: 'America/Chicago' },
  { label: 'Mountain Time', shortLabel: 'Mountain', value: 'America/Denver' },
  { label: 'Pacific Time', shortLabel: 'Pacific', value: 'America/Los_Angeles' },
] as const

export type ContinentalUsTimeZone = typeof continentalUsTimeZones[number]['value']

const supportedTimeZones = new Set<string>(continentalUsTimeZones.map((option) => option.value))

export function isContinentalUsTimeZone(value: string | null | undefined): value is ContinentalUsTimeZone {
  return Boolean(value && supportedTimeZones.has(value))
}

export function browserContinentalUsTimeZone(): ContinentalUsTimeZone | null {
  if (typeof Intl === 'undefined') return null

  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return isContinentalUsTimeZone(timeZone) ? timeZone : null
  } catch {
    return null
  }
}

export function personalDisplayTimeZone(profileTimeZone: string): string {
  return browserContinentalUsTimeZone() ?? profileTimeZone
}

export function continentalUsTimeZoneLabel(timeZone: string): string {
  return continentalUsTimeZones.find((option) => option.value === timeZone)?.label ?? timeZone
}

export function continentalUsTimeZoneShortLabel(timeZone: string): string {
  return continentalUsTimeZones.find((option) => option.value === timeZone)?.shortLabel ?? timeZone
}
