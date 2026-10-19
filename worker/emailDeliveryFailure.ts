export const providerRecipientSuppressedCode = 'E_RECIPIENT_SUPPRESSED'

export function emailDeliveryFailure(error: unknown): { code?: string; detail: string } {
  const providerError = typeof error === 'object' && error !== null ? error : null
  const code = providerError && 'code' in providerError && typeof providerError.code === 'string'
    ? providerError.code
    : undefined
  const message = providerError && 'message' in providerError && typeof providerError.message === 'string'
    ? providerError.message
    : 'Email delivery failed.'

  return { code, detail: code ? `${code}: ${message}` : message }
}
