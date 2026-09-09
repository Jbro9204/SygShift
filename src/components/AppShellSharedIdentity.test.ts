import { describe, expect, it } from 'vitest'
import type { SessionContext } from '../data/auth'
import { completedSignInRecordKind, requiresSecurityCheckpoint } from '../lib/securityCheckpoint'

const protectedSession: SessionContext = {
  displayName: 'Shared User',
  employeeId: 'a25a5f5f-45b6-4e43-87a6-79298ed9347f',
  hasMfa: false,
  mfaEnrolledAt: null,
  mfaRequired: true,
  mustChangePassword: false,
  passwordChangedAt: null,
  permissions: [],
  role: 'guard',
  timeZone: 'America/Denver',
  username: 'shareduser',
}

describe('AppShell shared identity checkpoint', () => {
  it('accepts inherited assurance only for the exact SygSphere route', () => {
    expect(requiresSecurityCheckpoint(protectedSession, '/sygsphere', true)).toBe(false)
    for (const path of ['/', '/time', '/support', '/tasks', '/hr', '/sygsphere/settings']) {
      expect(requiresSecurityCheckpoint(protectedSession, path, true)).toBe(true)
    }
  })

  it('never lets inherited assurance bypass a required password change', () => {
    expect(requiresSecurityCheckpoint({ ...protectedSession, mustChangePassword: true }, '/sygsphere', true)).toBe(true)
  })

  it('keeps the existing behavior for normal verified sessions', () => {
    expect(requiresSecurityCheckpoint({ ...protectedSession, hasMfa: true }, '/time', false)).toBe(false)
    expect(requiresSecurityCheckpoint({ ...protectedSession, mfaRequired: false }, '/time', false)).toBe(false)
  })

  it('records activity only after the applicable checkpoint is complete', () => {
    expect(completedSignInRecordKind(protectedSession, '/time', false)).toBeNull()
    expect(completedSignInRecordKind({ ...protectedSession, mustChangePassword: true }, '/sygsphere', true)).toBeNull()
    expect(completedSignInRecordKind({ ...protectedSession, hasMfa: true }, '/time', false)).toBe('native')
    expect(completedSignInRecordKind(protectedSession, '/sygsphere', true)).toBe('sygsphere')
    expect(completedSignInRecordKind(protectedSession, '/sygsphere/', true)).toBe('sygsphere')
  })
})
