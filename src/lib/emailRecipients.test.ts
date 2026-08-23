import { describe, expect, it } from 'vitest'
import {
  isTemporarilyBlockedRecipient,
  preferredEmployeeDeliveryEmail,
} from './emailRecipients'

describe('employee email delivery routing', () => {
  it('prefers a personal address when both personal and company addresses are deliverable', () => {
    expect(preferredEmployeeDeliveryEmail('Jordan.Personal@Example.com ', 'jordan@sygilant.us'))
      .toBe('jordan.personal@example.com')
  })

  it('uses an external company address only when no deliverable personal address exists', () => {
    expect(preferredEmployeeDeliveryEmail(null, 'employee@sygilant.us')).toBe('employee@sygilant.us')
  })

  it('rejects the temporarily blocked company domain regardless of case', () => {
    expect(isTemporarilyBlockedRecipient('PERSON@GUARDIANSHIPSECURITY.NET')).toBe(true)
    expect(preferredEmployeeDeliveryEmail(null, 'person@guardianshipsecurity.net')).toBeNull()
  })

  it('falls back to another external address when a blocked address is stored in the personal field', () => {
    expect(preferredEmployeeDeliveryEmail('person@guardianshipsecurity.net', 'person@sygilant.us'))
      .toBe('person@sygilant.us')
  })

  it('does not treat a subdomain or lookalike domain as the blocked company domain', () => {
    expect(isTemporarilyBlockedRecipient('person@mail.guardianshipsecurity.net')).toBe(false)
    expect(isTemporarilyBlockedRecipient('person@guardianshipsecurity.net.example.com')).toBe(false)
  })
})
