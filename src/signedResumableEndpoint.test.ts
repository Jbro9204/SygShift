/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { signedStorageResumableEndpoint, storageResumableEndpoint } from '../worker'

const workerSource = readFileSync(join(process.cwd(), 'worker', 'index.ts'), 'utf8')

describe('Supabase Storage resumable endpoints', () => {
  it('uses the signed TUS route for signed upload tokens on the direct storage origin', () => {
    expect(signedStorageResumableEndpoint('https://example.supabase.co')).toBe(
      'https://example.storage.supabase.co/storage/v1/upload/resumable/sign',
    )
  })

  it('preserves the unsigned TUS route independently', () => {
    expect(storageResumableEndpoint('https://example.supabase.co')).toBe(
      'https://example.storage.supabase.co/storage/v1/upload/resumable',
    )
    expect(storageResumableEndpoint('http://127.0.0.1:54321')).toBe(
      'http://127.0.0.1:54321/storage/v1/upload/resumable',
    )
  })

  it('binds both SygSphere and Patrol signed-token responses to the signed route helper', () => {
    expect(workerSource.match(
      /resumableEndpoint:\s+signedStorageResumableEndpoint\(session\.config\.url\)/g,
    )).toHaveLength(2)
    expect(workerSource).not.toContain(
      'resumableEndpoint: storageResumableEndpoint(session.config.url)',
    )
  })
})
