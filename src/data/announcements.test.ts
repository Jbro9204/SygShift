import { describe, expect, it } from 'vitest'
import { emptyFields, recipientSummary, type AnnouncementTemplate } from './announcements'

const template: AnnouncementTemplate = {
  key: 'open_shift_available',
  name: 'Open shift available',
  description: 'Coverage needed.',
  kind: 'open_shift',
  displayOrder: 10,
  recipientRoles: ['guard'],
  requiredFields: [
    { key: 'site', label: 'Site', type: 'text' },
    { key: 'notes', label: 'Notes', type: 'textarea' },
  ],
}

describe('announcement template helpers', () => {
  it('creates an empty field map from approved template fields', () => {
    expect(emptyFields(template)).toEqual({ notes: '', site: '' })
  })

  it('summarizes recipient scope clearly', () => {
    expect(recipientSummary({ recipientCount: 17, recipientRoles: ['guard'], requiresArmed: true }))
      .toBe('17 armed-qualified guards')
  })
})
