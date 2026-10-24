import type { NotificationProcessResult } from '../data/operations'

type ScheduleNotificationDeliveryResult = Pick<NotificationProcessResult, 'outcomes' | 'processed'>

function recipientCount(count: number): string {
  return `${count} recipient${count === 1 ? '' : 's'}`
}

export function scheduleNotificationFeedback(
  weekLabel: string,
  notificationId: string,
  delivery: ScheduleNotificationDeliveryResult,
): string {
  const scheduleAvailable = `The published schedule for ${weekLabel} remains available in SygShift.`
  const outcome = delivery.outcomes.find((candidate) => candidate.id === notificationId)

  if (!outcome) {
    return delivery.processed === 0
      ? `${scheduleAvailable} The exact email notice was not ready for delivery; no delivery was claimed.`
      : `${scheduleAvailable} The exact email notice's delivery result could not be verified. Check the notification center before retrying.`
  }
  const { accepted, completionPending, suppressed, total, uncertain } = outcome.recipients
  const unresolved = completionPending + uncertain

  if (outcome.status === 'pending' || unresolved > 0) {
    const acceptedMessage = accepted > 0
      ? `${recipientCount(accepted)} ${accepted === 1 ? 'was' : 'were'} accepted by the email provider; `
      : ''
    return `${scheduleAvailable} ${acceptedMessage}${recipientCount(unresolved)} ${unresolved === 1 ? 'requires' : 'require'} delivery reconciliation. SygShift will not automatically resend them.`
  }
  if (outcome.status === 'failed') {
    return `${scheduleAvailable} Email delivery failed for the targeted notice${total > 0 ? ` covering ${recipientCount(total)}` : ''}.`
  }
  if (outcome.status === 'suppressed' || (accepted === 0 && suppressed > 0)) {
    return `${scheduleAvailable} No email was sent${suppressed > 0 ? ` to ${recipientCount(suppressed)}` : ''} because delivery was suppressed.`
  }
  if (accepted > 0 && suppressed > 0) {
    return `${scheduleAvailable} Email was accepted for ${recipientCount(accepted)}; ${recipientCount(suppressed)} ${suppressed === 1 ? 'was' : 'were'} suppressed.`
  }
  if (outcome.status === 'delivered' && accepted > 0) {
    return `${scheduleAvailable} Email was accepted for all ${recipientCount(accepted)}.`
  }

  return `${scheduleAvailable} The targeted notice was processed, but no recipient delivery was confirmed.`
}
