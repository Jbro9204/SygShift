const TRUE_VALUES = new Set(['1', 'on', 'true', 'yes'])

export function securityKeyFeatureEnabled(value: string | undefined): boolean {
  return TRUE_VALUES.has(value?.trim().toLowerCase() ?? '')
}

export function securityKeyPilotUsernames(value: string | undefined): string[] {
  return [...new Set((value ?? '')
    .split(',')
    .map((username) => username.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean))]
}

export function isSecurityKeyPilotEligible(
  enabledValue: string | undefined,
  allowlistValue: string | undefined,
  username: string | undefined,
): boolean {
  if (!securityKeyFeatureEnabled(enabledValue)) return false
  const normalizedUsername = username?.trim().toLowerCase().replace(/^@/, '') ?? ''
  return Boolean(normalizedUsername) && securityKeyPilotUsernames(allowlistValue).includes(normalizedUsername)
}
