import { describe, expect, it } from 'vitest'
import {
  AUTH_EMAIL_DOMAIN,
  isValidUsername,
  normalizeUsername,
  usernameToAuthEmail,
  validatePassword,
} from './auth'

describe('auth helpers', () => {
  it('normalizes directory usernames before creating Supabase auth identifiers', () => {
    expect(normalizeUsername(' JBrown ')).toBe('jbrown')
    expect(usernameToAuthEmail(' JBrown ')).toBe(`jbrown@${AUTH_EMAIL_DOMAIN}`)
  })

  it('rejects malformed usernames', () => {
    expect(isValidUsername('jbrown')).toBe(true)
    expect(isValidUsername('1brown')).toBe(false)
    expect(isValidUsername('j.brown')).toBe(false)
    expect(() => usernameToAuthEmail('j brown')).toThrow('valid SygShift username')
  })

  it('requires permanent passwords to be strong and account-specific', () => {
    expect(validatePassword('short', 'jbrown').valid).toBe(false)
    expect(validatePassword('JBrown-Schedule-2026!', 'jbrown').valid).toBe(false)
    expect(validatePassword('Copper!River!4729', 'jbrown').valid).toBe(true)
  })
})
