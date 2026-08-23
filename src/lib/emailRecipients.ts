export const temporarilyBlockedRecipientDomains = new Set(['guardianshipsecurity.net'])

function normalizeEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? ''
  return normalized.includes('@') ? normalized : null
}

export function isTemporarilyBlockedRecipient(value: string | null | undefined): boolean {
  const email = normalizeEmail(value)
  if (!email) return false
  const domain = email.split('@').at(-1) ?? ''
  return temporarilyBlockedRecipientDomains.has(domain)
}

export function preferredEmployeeDeliveryEmail(
  personalEmail: string | null | undefined,
  companyEmail: string | null | undefined,
): string | null {
  return [personalEmail, companyEmail]
    .map(normalizeEmail)
    .find((email) => email !== null && !isTemporarilyBlockedRecipient(email)) ?? null
}
