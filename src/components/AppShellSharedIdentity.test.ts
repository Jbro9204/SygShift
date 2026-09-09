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
    expect(requiresSecurityCheckpoint(protectedSession, '/sygsphere', 'sygsphere')).toBe(false)
    for (const path of ['/', '/time', '/support', '/tasks', '/hr', '/sygsphere/settings']) {
      expect(requiresSecurityCheckpoint(protectedSession, path, 'sygsphere')).toBe(true)
    }
  })

  it('confines SygSphere sessions even when the employee role does not require MFA', () => {
    const ordinarySession = { ...protectedSession, mfaRequired: false }
    expect(requiresSecurityCheckpoint(ordinarySession, '/sygsphere', 'sygsphere')).toBe(false)
    expect(requiresSecurityCheckpoint(ordinarySession, '/', 'sygsphere')).toBe(true)
    expect(requiresSecurityCheckpoint(ordinarySession, '/time', 'sygsphere')).toBe(true)
  })

  it('accepts platform assurance across SygShift without changing route permissions', () => {
    for (const path of ['/', '/time', '/support', '/tasks', '/hr', '/sygsphere']) {
      expect(requiresSecurityCheckpoint(protectedSession, path, 'platform')).toBe(false)
    }
  })

  it('never lets inherited assurance bypass a required password change', () => {
    expect(requiresSecurityCheckpoint({ ...protectedSession, mustChangePassword: true }, '/sygsphere', 'sygsphere')).toBe(true)
    expect(requiresSecurityCheckpoint({ ...protectedSession, mustChangePassword: true }, '/', 'platform')).toBe(true)
  })

  it('keeps the existing behavior for normal verified sessions', () => {
    expect(requiresSecurityCheckpoint({ ...protectedSession, hasMfa: true }, '/time', null)).toBe(false)
    expect(requiresSecurityCheckpoint({ ...protectedSession, mfaRequired: false }, '/time', null)).toBe(false)
  })

  it('records activity only after the applicable checkpoint is complete', () => {
    expect(completedSignInRecordKind(protectedSession, '/time', null)).toBeNull()
    expect(completedSignInRecordKind({ ...protectedSession, mustChangePassword: true }, '/sygsphere', 'sygsphere')).toBeNull()
    expect(completedSignInRecordKind({ ...protectedSession, hasMfa: true }, '/time', null)).toBe('native')
    expect(completedSignInRecordKind(protectedSession, '/sygsphere', 'sygsphere')).toBe('sygsphere')
    expect(completedSignInRecordKind(protectedSession, '/sygsphere/', 'sygsphere')).toBe('sygsphere')
    expect(completedSignInRecordKind(protectedSession, '/', 'platform')).toBe('platform')
  })
})
