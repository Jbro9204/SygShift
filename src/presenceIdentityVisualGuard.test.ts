import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sphereCss = readFileSync('src/styles/sygsphere.css', 'utf8')
const appCss = readFileSync('src/App.css', 'utf8')

describe('presence identity visual contract', () => {
  it('keeps SygSphere avatars and activity indicators large enough to distinguish', () => {
    expect(sphereCss).toContain('--sp-identity-avatar:44px')
    expect(sphereCss).toContain('--sp-message-avatar:40px')
    expect(sphereCss).toContain('--sp-mobile-message-avatar:36px')
    expect(sphereCss).toContain('--sp-avatar-presence:14px')
    expect(sphereCss).toContain('--sp-inline-presence:11px')
  })

  it('keeps Never active visually distinct without relying on color alone', () => {
    expect(sphereCss).toContain('.sphere-avatar__presence--never_active{')
    expect(sphereCss).toContain('box-shadow:inset 0 0 0 2px #737c80')
    expect(appCss).toContain('.account-presence--never_active i')
    expect(appCss).toContain('box-shadow: inset 0 0 0 2px #737c80')
  })
})
