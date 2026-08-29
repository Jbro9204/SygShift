import { describe, expect, it } from 'vitest'
import {
  isSecurityKeyPilotEligible,
  securityKeyFeatureEnabled,
  securityKeyPilotUsernames,
} from '../worker/securityKeyPilot'

describe('security-key pilot controls', () => {
  it('requires an explicit enabled value', () => {
    expect(securityKeyFeatureEnabled(undefined)).toBe(false)
    expect(securityKeyFeatureEnabled('false')).toBe(false)
    expect(securityKeyFeatureEnabled('true')).toBe(true)
    expect(securityKeyFeatureEnabled(' ON ')).toBe(true)
  })

  it('normalizes and deduplicates the pilot allowlist', () => {
    expect(securityKeyPilotUsernames(' @JBrown, jbrown, MSWINNEY ')).toEqual(['jbrown', 'mswinney'])
  })

  it('allows only an enabled, explicitly listed user', () => {
    expect(isSecurityKeyPilotEligible('true', 'jbrown', '@JBROWN')).toBe(true)
    expect(isSecurityKeyPilotEligible('true', 'jbrown', 'mhinz')).toBe(false)
    expect(isSecurityKeyPilotEligible('false', 'jbrown', 'jbrown')).toBe(false)
  })
})
