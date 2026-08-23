import { describe, expect, it } from 'vitest'
import { releaseAssetFromHtml } from './lib/releaseUpdate'

describe('release update notice', () => {
  it('finds the current hashed module asset regardless of attribute order', () => {
    expect(releaseAssetFromHtml(`<!doctype html><script src="/assets/index-current.js" type="module"></script>`))
      .toBe('/assets/index-current.js')
    expect(releaseAssetFromHtml(`<!doctype html><script type='module' crossorigin src='/assets/index-next.js'></script>`))
      .toBe('/assets/index-next.js')
  })

  it('ignores non-module scripts instead of raising a false update', () => {
    expect(releaseAssetFromHtml('<script src="/legacy.js"></script>')).toBeNull()
  })
})
