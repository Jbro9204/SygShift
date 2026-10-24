import { createHash } from 'node:crypto'
import { PDFDocument } from 'pdf-lib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  finalizeSignatureEnvelope,
  persistProfilePhotoUpload,
  recoverProtectedStorageCleanup,
  ScheduledSupabaseUnavailableError,
  signatureAppearanceObjectKey,
  SupabaseRequestError,
} from '../worker'

class TestDigestStream extends WritableStream<Uint8Array> {
  declare readonly bytesWritten: number
  readonly digest: Promise<ArrayBuffer>

  constructor() {
    let bytesWritten = 0
    const hash = createHash('sha256')
    let resolveDigest!: (value: ArrayBuffer) => void
    const digest = new Promise<ArrayBuffer>((resolve) => { resolveDigest = resolve })
    super({
      write(chunk) {
        bytesWritten += chunk.byteLength
        hash.update(chunk)
      },
      close() {
        const value = hash.digest()
        resolveDigest(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer)
      },
    })
    Object.defineProperty(this, 'bytesWritten', { get: () => bytesWritten })
    this.digest = digest
  }
}

const originalDigestStream = (crypto as Crypto & { DigestStream?: unknown }).DigestStream

afterEach(() => {
  if (originalDigestStream === undefined) delete (crypto as Crypto & { DigestStream?: unknown }).DigestStream
  else Object.defineProperty(crypto, 'DigestStream', { configurable: true, value: originalDigestStream })
  vi.unstubAllGlobals()
})

describe('durable generated artifact recovery', () => {
  it('reuses the same final PDF and audit artifacts after job reclaim', async () => {
    Object.defineProperty(crypto, 'DigestStream', { configurable: true, value: TestDigestStream })
    const envelopeId = '10000000-0000-4000-8000-000000000110'
    const jobId = '10000000-0000-4000-8000-000000000111'
    const source = await PDFDocument.create()
    source.addPage([612, 792])
    const sourceBytes = await source.save({ useObjectStreams: false })
    const sourceChecksum = createHash('sha256').update(sourceBytes).digest('hex')
    const storedObjects = new Map<string, Uint8Array>()
    const postUrls: string[] = []
    const deletedUrls: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (method === 'POST') {
        postUrls.push(url)
        if (storedObjects.has(url)) return new Response(null, { status: 409 })
        storedObjects.set(url, new Uint8Array(init?.body as ArrayBuffer))
        return new Response(null, { status: 200 })
      }
      if (method === 'DELETE') {
        deletedUrls.push(url)
        storedObjects.delete(url)
        return new Response(null, { status: 200 })
      }
      const bytes = url.endsWith('/hr-general/source/source.pdf') ? sourceBytes : storedObjects.get(url)
      if (!bytes) return new Response(null, { status: 404 })
      return new Response(new Uint8Array(bytes).buffer as ArrayBuffer, {
        headers: { 'content-length': String(bytes.byteLength) },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const payload = {
      state: 'processing',
      jobId,
      envelopeId,
      documentId: '10000000-0000-4000-8000-000000000112',
      documentTitle: 'Durable test document',
      sourceBucket: 'hr-general',
      sourceObjectKey: 'source/source.pdf',
      sourceMimeType: 'application/pdf',
      sourceChecksum,
      recipients: [],
      events: [{ occurredAt: '2026-10-24T12:00:00.000Z' }],
    }
    const firstRpc = vi.fn(async (_config: unknown, name: string) => {
      if (name === 'service_get_signature_finalization_payload') return payload
      if (name === 'service_commit_signature_finalization') {
        throw new ScheduledSupabaseUnavailableError(name, 504, 'Commit response timed out.')
      }
      return null
    }) as unknown as Parameters<typeof finalizeSignatureEnvelope>[3]

    await expect(finalizeSignatureEnvelope(
      { serviceRoleKey: 'service-role', url: 'https://example.supabase.co' },
      envelopeId,
      'first-process',
      firstRpc,
    )).rejects.toBeInstanceOf(ScheduledSupabaseUnavailableError)
    const firstArtifacts = new Map(storedObjects)
    expect([...storedObjects.keys()]).toEqual(expect.arrayContaining([
      expect.stringContaining(`${envelopeId}/${jobId}`),
      expect.stringContaining(`${jobId}/${envelopeId}`),
    ]))

    const secondRpc = vi.fn(async (_config: unknown, name: string, args?: Record<string, unknown>) => {
      if (name === 'service_get_signature_finalization_payload') return payload
      if (name === 'service_commit_signature_finalization') {
        return { finalVersionId: '10000000-0000-4000-8000-000000000113', id: envelopeId, status: 'completed', ...args }
      }
      return null
    }) as unknown as Parameters<typeof finalizeSignatureEnvelope>[3]
    await expect(finalizeSignatureEnvelope(
      { serviceRoleKey: 'service-role', url: 'https://example.supabase.co' },
      envelopeId,
      'reclaimed-process',
      secondRpc,
    )).resolves.toMatchObject({ status: 'completed' })

    expect(postUrls).toHaveLength(4)
    expect(new Set(postUrls).size).toBe(2)
    expect(deletedUrls).toHaveLength(0)
    expect(storedObjects.size).toBe(2)
    for (const [url, bytes] of firstArtifacts) {
      expect(storedObjects.get(url)).toEqual(bytes)
    }
  })

  it('derives signature appearance identities from durable action inputs', () => {
    const employeeId = '10000000-0000-4000-8000-000000000120'
    const recipientId = '10000000-0000-4000-8000-000000000121'
    const operationId = '10000000-0000-4000-8000-000000000122'
    const checksum = 'a'.repeat(64)
    expect(signatureAppearanceObjectKey(employeeId, recipientId, operationId, checksum, 'image/png')).toBe(
      signatureAppearanceObjectKey(employeeId, recipientId, operationId, checksum, 'image/png'),
    )
    expect(signatureAppearanceObjectKey(employeeId, recipientId, operationId, checksum, 'image/png')).toBe(
      `${employeeId}/${recipientId}/${operationId}/${checksum}.png`,
    )
  })

  it('reuses a preserved profile photo on retry after an unavailable completion response', async () => {
    Object.defineProperty(crypto, 'DigestStream', { configurable: true, value: TestDigestStream })
    const employeeId = '10000000-0000-4000-8000-000000000130'
    const previousPath = `${employeeId}/previous.jpg`
    const operationId = '10000000-0000-4000-8000-000000000131'
    const photoBytes = Uint8Array.from([0xff, 0xd8, 0xff, ...Array.from({ length: 64 }, (_, index) => index), 0xff, 0xd9])
    const checksum = createHash('sha256').update(photoBytes).digest('hex')
    const candidatePath = `${employeeId}/${operationId}/${checksum}.jpg`
    const storedObjects = new Map<string, Uint8Array>()
    const deletedUrls: string[] = []
    const postUrls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (method === 'POST') {
        postUrls.push(url)
        if (storedObjects.has(url)) return new Response(null, { status: 409 })
        storedObjects.set(url, new Uint8Array(init?.body as ArrayBuffer))
        return new Response(null, { status: 200 })
      }
      if (method === 'DELETE') {
        deletedUrls.push(url)
        storedObjects.delete(url)
        return new Response(null, { status: 200 })
      }
      const bytes = storedObjects.get(url)
      if (!bytes) return new Response(null, { status: 404 })
      return new Response(new Uint8Array(bytes).buffer as ArrayBuffer, {
        headers: { 'content-length': String(bytes.byteLength) },
      })
    }))
    const firstRpc = vi.fn(async (_config: unknown, name: string) => {
      if (name === 'service_prepare_employee_photo_upload_v2') {
        return { currentPath: previousPath, operationId, photoPath: candidatePath, previousPath, state: 'prepared' }
      }
      if (name === 'service_complete_employee_photo_upload_v2') {
        throw new SupabaseRequestError('Completion response timed out.', 504, null, name)
      }
      if (name === 'service_get_employee_photo_path') throw new TypeError('database unavailable')
      return null
    }) as unknown as Parameters<typeof persistProfilePhotoUpload>[6]

    await expect(persistProfilePhotoUpload(
      { serviceRoleKey: 'service-role', url: 'https://example.supabase.co' },
      employeeId,
      previousPath,
      photoBytes,
      'image/jpeg',
      'first-photo-process',
      firstRpc,
    )).rejects.toMatchObject({ code: 'profile_photo_finalization_pending', status: 503 })
    expect(storedObjects.size).toBe(1)

    const secondRpc = vi.fn(async (_config: unknown, name: string) => {
      if (name === 'service_prepare_employee_photo_upload_v2') {
        return { currentPath: candidatePath, operationId, photoPath: candidatePath, previousPath, state: 'completed' }
      }
      if (name === 'service_complete_employee_photo_upload_v2') {
        return { currentPath: candidatePath, operationId, photoPath: candidatePath, previousPath, state: 'completed' }
      }
      return null
    }) as unknown as Parameters<typeof persistProfilePhotoUpload>[6]
    await expect(persistProfilePhotoUpload(
      { serviceRoleKey: 'service-role', url: 'https://example.supabase.co' },
      employeeId,
      previousPath,
      photoBytes,
      'image/jpeg',
      'restarted-photo-process',
      secondRpc,
    )).resolves.toEqual({ path: candidatePath, previousPath })

    expect(postUrls).toHaveLength(2)
    expect(new Set(postUrls).size).toBe(1)
    expect(deletedUrls).toHaveLength(0)
  })

  it('allocates a new operation-scoped identity for a valid A to B to A photo sequence', async () => {
    Object.defineProperty(crypto, 'DigestStream', { configurable: true, value: TestDigestStream })
    const employeeId = '10000000-0000-4000-8000-000000000140'
    const operationIds = [
      '10000000-0000-4000-8000-000000000141',
      '10000000-0000-4000-8000-000000000142',
      '10000000-0000-4000-8000-000000000143',
    ]
    const photoA = Uint8Array.from([0xff, 0xd8, 0xff, ...Array.from({ length: 64 }, (_, index) => index), 0xff, 0xd9])
    const photoB = Uint8Array.from([0xff, 0xd8, 0xff, ...Array.from({ length: 64 }, (_, index) => 255 - index), 0xff, 0xd9])
    const storedObjects = new Map<string, Uint8Array>()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if ((init?.method ?? 'GET') === 'POST') {
        if (storedObjects.has(url)) return new Response(null, { status: 409 })
        storedObjects.set(url, new Uint8Array(init?.body as ArrayBuffer))
        return new Response(null, { status: 200 })
      }
      const bytes = storedObjects.get(url)
      return bytes
        ? new Response(new Uint8Array(bytes).buffer as ArrayBuffer, { headers: { 'content-length': String(bytes.byteLength) } })
        : new Response(null, { status: 404 })
    }))
    let currentPath: string | null = null
    let operationIndex = 0
    const rpc = vi.fn(async (_config: unknown, name: string, args: Record<string, unknown>) => {
      if (name === 'service_prepare_employee_photo_upload_v2') {
        expect(args.target_expected_photo_path ?? null).toBe(currentPath)
        const operationId = operationIds[operationIndex]
        const path = `${employeeId}/${operationId}/${String(args.target_photo_checksum)}.${String(args.target_extension)}`
        return { currentPath, operationId, photoPath: path, previousPath: currentPath, state: 'prepared' }
      }
      if (name === 'service_complete_employee_photo_upload_v2') {
        const previousPath = currentPath
        currentPath = String(args.target_photo_path)
        operationIndex += 1
        return {
          currentPath,
          operationId: args.target_operation_id,
          photoPath: currentPath,
          previousPath,
          state: 'completed',
        }
      }
      return null
    }) as unknown as Parameters<typeof persistProfilePhotoUpload>[6]

    const firstA = await persistProfilePhotoUpload(
      { serviceRoleKey: 'service-role', url: 'https://example.supabase.co' },
      employeeId,
      null,
      photoA,
      'image/jpeg',
      'a-first',
      rpc,
    )
    const b = await persistProfilePhotoUpload(
      { serviceRoleKey: 'service-role', url: 'https://example.supabase.co' },
      employeeId,
      firstA.path,
      photoB,
      'image/jpeg',
      'b',
      rpc,
    )
    const secondA = await persistProfilePhotoUpload(
      { serviceRoleKey: 'service-role', url: 'https://example.supabase.co' },
      employeeId,
      b.path,
      photoA,
      'image/jpeg',
      'a-second',
      rpc,
    )

    expect(firstA.path).not.toBe(secondA.path)
    expect(firstA.path).toContain(`/${operationIds[0]}/`)
    expect(secondA.path).toContain(`/${operationIds[2]}/`)
    expect(storedObjects).toHaveLength(3)
  })

  it('reclaims failed protected cleanup across runs and never deletes a mismatched object', async () => {
    Object.defineProperty(crypto, 'DigestStream', { configurable: true, value: TestDigestStream })
    const exactBytes = new TextEncoder().encode('exact signature appearance')
    const mismatchBytes = new TextEncoder().encode('different protected content')
    const exactChecksum = createHash('sha256').update(exactBytes).digest('hex')
    const exactId = '10000000-0000-4000-8000-000000000151'
    const mismatchId = '10000000-0000-4000-8000-000000000152'
    const rpcCalls: Array<{ args: Record<string, unknown>, name: string }> = []
    const rpc = vi.fn(async (_config: unknown, name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ args, name })
      if (name === 'service_reconcile_stale_signature_appearances_v2') return { reconciled: 1 }
      if (name === 'service_list_protected_storage_cleanup_v2') {
        return [
          {
            attemptCount: rpcCalls.filter((call) => call.name === name).length,
            bucket: 'signature-appearances',
            checksum: exactChecksum,
            id: exactId,
            kind: 'signature_appearance',
            leaseOwner: args.target_lease_owner,
            objectKey: 'employee/recipient/operation/exact.png',
            sizeBytes: exactBytes.byteLength,
          },
          {
            attemptCount: rpcCalls.filter((call) => call.name === name).length,
            bucket: 'employee-photos',
            checksum: 'f'.repeat(64),
            id: mismatchId,
            kind: 'profile_photo',
            leaseOwner: args.target_lease_owner,
            objectKey: 'employee/operation/mismatch.jpg',
            sizeBytes: mismatchBytes.byteLength,
          },
        ]
      }
      return null
    }) as unknown as Parameters<typeof recoverProtectedStorageCleanup>[1]
    let exactDeleteAttempts = 0
    const deleted: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'DELETE') {
        deleted.push(url)
        exactDeleteAttempts += 1
        return new Response(null, { status: exactDeleteAttempts === 1 ? 503 : 204 })
      }
      if (url.endsWith('/exact.png')) return new Response(exactBytes, { headers: { 'content-length': String(exactBytes.byteLength) } })
      if (url.endsWith('/mismatch.jpg')) return new Response(mismatchBytes, { headers: { 'content-length': String(mismatchBytes.byteLength) } })
      return new Response(null, { status: 404 })
    }))
    const environment = {
      SUPABASE_PUBLISHABLE_KEY: 'publishable',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role',
      SUPABASE_URL: 'https://example.supabase.co',
    } as unknown as Parameters<typeof recoverProtectedStorageCleanup>[0]

    await expect(recoverProtectedStorageCleanup(environment, rpc)).resolves.toEqual({ cleaned: 0, deferred: 2, failed: 0, reconciled: 1 })
    await expect(recoverProtectedStorageCleanup(environment, rpc)).resolves.toEqual({ cleaned: 1, deferred: 1, failed: 0, reconciled: 1 })
    expect(deleted).toHaveLength(2)
    expect(deleted.every((url) => url.endsWith('/exact.png'))).toBe(true)
    expect(rpcCalls.filter((call) => call.name === 'service_complete_protected_storage_cleanup_v2')).toHaveLength(1)
    expect(rpcCalls.filter((call) => call.name === 'service_defer_protected_storage_cleanup_v2')).toHaveLength(3)
  })

  it('retries only the exact cleanup lease result after a committed response is lost', async () => {
    Object.defineProperty(crypto, 'DigestStream', { configurable: true, value: TestDigestStream })
    const exactBytes = new TextEncoder().encode('exact cleanup response-loss object')
    const mismatchBytes = new TextEncoder().encode('mismatched cleanup response-loss object')
    const exactChecksum = createHash('sha256').update(exactBytes).digest('hex')
    const exactId = '10000000-0000-4000-8000-000000000161'
    const mismatchId = '10000000-0000-4000-8000-000000000162'
    let completeCalls = 0
    let deferCalls = 0
    const rpc = vi.fn(async (_config: unknown, name: string, args: Record<string, unknown>) => {
      if (name === 'service_reconcile_stale_employee_photo_uploads_v2') return { reconciled: 0 }
      if (name === 'service_reconcile_stale_signature_appearances_v2') return { reconciled: 0 }
      if (name === 'service_list_protected_storage_cleanup_v2') {
        return [
          {
            attemptCount: 1,
            bucket: 'signature-appearances',
            checksum: exactChecksum,
            id: exactId,
            kind: 'signature_appearance',
            leaseOwner: args.target_lease_owner,
            objectKey: 'employee/recipient/operation/response-loss.png',
            sizeBytes: exactBytes.byteLength,
          },
          {
            attemptCount: 1,
            bucket: 'employee-photos',
            checksum: 'f'.repeat(64),
            id: mismatchId,
            kind: 'profile_photo',
            leaseOwner: args.target_lease_owner,
            objectKey: 'employee/operation/defer-response-loss.jpg',
            sizeBytes: mismatchBytes.byteLength,
          },
        ]
      }
      if (name === 'service_complete_protected_storage_cleanup_v2') {
        completeCalls += 1
        if (completeCalls === 1) {
          throw new SupabaseRequestError('Committed completion response was lost.', 503, null, name)
        }
        return null
      }
      if (name === 'service_defer_protected_storage_cleanup_v2') {
        deferCalls += 1
        if (deferCalls === 1) {
          throw new SupabaseRequestError('Committed defer response was lost.', 503, null, name)
        }
        return null
      }
      return null
    }) as unknown as Parameters<typeof recoverProtectedStorageCleanup>[1]
    const deleted: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'DELETE') {
        deleted.push(url)
        return new Response(null, { status: 204 })
      }
      if (url.endsWith('/response-loss.png')) {
        return new Response(exactBytes, { headers: { 'content-length': String(exactBytes.byteLength) } })
      }
      if (url.endsWith('/defer-response-loss.jpg')) {
        return new Response(mismatchBytes, { headers: { 'content-length': String(mismatchBytes.byteLength) } })
      }
      return new Response(null, { status: 404 })
    }))
    const environment = {
      SUPABASE_PUBLISHABLE_KEY: 'publishable',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role',
      SUPABASE_URL: 'https://example.supabase.co',
    } as unknown as Parameters<typeof recoverProtectedStorageCleanup>[0]

    await expect(recoverProtectedStorageCleanup(environment, rpc)).resolves.toEqual({
      cleaned: 1,
      deferred: 1,
      failed: 0,
      reconciled: 0,
    })
    expect(completeCalls).toBe(2)
    expect(deferCalls).toBe(2)
    expect(deleted).toHaveLength(1)
    expect(deleted[0]).toContain('/response-loss.png')
  })

  it('leaves an uncertain completion lease reclaimable instead of recording a false failure', async () => {
    Object.defineProperty(crypto, 'DigestStream', { configurable: true, value: TestDigestStream })
    const bytes = new TextEncoder().encode('completion remains uncertain')
    const checksum = createHash('sha256').update(bytes).digest('hex')
    let completeCalls = 0
    let deferCalls = 0
    const rpc = vi.fn(async (_config: unknown, name: string, args: Record<string, unknown>) => {
      if (name === 'service_reconcile_stale_employee_photo_uploads_v2') return { reconciled: 0 }
      if (name === 'service_reconcile_stale_signature_appearances_v2') return { reconciled: 0 }
      if (name === 'service_list_protected_storage_cleanup_v2') {
        return [{
          attemptCount: 1,
          bucket: 'signature-appearances',
          checksum,
          id: '10000000-0000-4000-8000-000000000163',
          kind: 'signature_appearance',
          leaseOwner: args.target_lease_owner,
          objectKey: 'employee/recipient/operation/uncertain-completion.png',
          sizeBytes: bytes.byteLength,
        }]
      }
      if (name === 'service_complete_protected_storage_cleanup_v2') {
        completeCalls += 1
        throw new SupabaseRequestError('Completion response remained unavailable.', 503, null, name)
      }
      if (name === 'service_defer_protected_storage_cleanup_v2') {
        deferCalls += 1
      }
      return null
    }) as unknown as Parameters<typeof recoverProtectedStorageCleanup>[1]
    let deleteCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deleteCalls += 1
        return new Response(null, { status: 204 })
      }
      return new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } })
    }))
    const environment = {
      SUPABASE_PUBLISHABLE_KEY: 'publishable',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role',
      SUPABASE_URL: 'https://example.supabase.co',
    } as unknown as Parameters<typeof recoverProtectedStorageCleanup>[0]

    await expect(recoverProtectedStorageCleanup(environment, rpc)).resolves.toEqual({
      cleaned: 0,
      deferred: 0,
      failed: 1,
      reconciled: 0,
    })
    expect(completeCalls).toBe(3)
    expect(deferCalls).toBe(0)
    expect(deleteCalls).toBe(1)
  })
})
