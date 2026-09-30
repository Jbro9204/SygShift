const genericCopyWeekFailure =
  'The schedule could not be copied. Nothing was changed. Try again in a moment. If it keeps happening, contact an administrator.'

export function copyWeekFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.toLocaleLowerCase() : ''

  if (/(statement timeout|canceling statement|query timeout|timed out|57014)/.test(message)) {
    return 'The copy took too long to finish safely. Nothing was changed. Try again in a moment. If it keeps happening, contact an administrator.'
  }

  if (/(permission denied|not authorized|unauthorized|mfa required)/.test(message)) {
    return 'You do not have access to copy this week. Nothing was changed. Refresh the page and try again, or contact an administrator if you need access.'
  }

  if (/(source revision|destination.*match|schedule.*changed|stale)/.test(message)) {
    return 'The schedule changed before the copy finished. Nothing was changed. Refresh the week and try again.'
  }

  return genericCopyWeekFailure
}
