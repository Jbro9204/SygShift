import { z } from 'zod'

const uuid = z.string().uuid()
const accessSchema = z.object({ filename: z.string(), mimeType: z.string(), sizeBytes: z.number(), objectKey: z.string() })
const operationSchema = z.object({ id: z.string().uuid(), state: z.enum(['pending', 'clean', 'rejected', 'error']), messageId: z.string().nullable() })
const previewMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain'])
type Dependencies = {
  actorId: string
  authorize: (action: string, input: Record<string, unknown>) => Promise<unknown>
  operation: (action: string, input: Record<string, unknown>) => Promise<unknown>
  validate: (bytes: Uint8Array, filename: string, mimeType: string) => { detectedMimeType: string; sanitizedFilename: string }
  store: (path: string, bytes: Uint8Array, mime: string) => Promise<void>
  fetch: (path: string) => Promise<Response>
}
const failure = (message: string, status = 400) => Response.json({ error: 'sygsphere_file_error', detail: message }, { status, headers: { 'cache-control': 'private, no-store' } })

export async function boundedSphereUpload(request: Pick<Request, 'body' | 'headers'>): Promise<Uint8Array> {
  const limit = 26214400
  const declared = Number(request.headers.get('content-length'))
  if (declared > limit) throw new Error('Files must be no larger than 25 MB.')
  const reader = request.body?.getReader()
  if (!reader) throw new Error('Choose a file to share.')
  const chunks: Uint8Array[] = []; let length = 0
  try {
    while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > limit) { await reader.cancel(); throw new Error('Files must be no larger than 25 MB.') } chunks.push(part.value) }
  } finally { reader.releaseLock() }
  if (!length) throw new Error('Empty files cannot be shared.')
  const bytes = new Uint8Array(length); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}

async function verifyStoredSphereFile(
  stored: Response,
  expectedSizeBytes: number,
  expectedChecksum: string,
): Promise<void> {
  if (!stored.ok) throw new Error('The file could not be stored securely.')
  const storedBytes = await boundedSphereUpload(stored)
  if (storedBytes.byteLength !== expectedSizeBytes) {
    throw new Error('The stored file size does not match the approved upload.')
  }
  const storedHash = await crypto.subtle.digest('SHA-256', new Uint8Array(storedBytes).buffer)
  const storedChecksum = [...new Uint8Array(storedHash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  if (storedChecksum !== expectedChecksum) {
    throw new Error('The stored file checksum does not match the approved upload.')
  }
}

export async function handleSphereFiles(request: Request, dependencies: Dependencies): Promise<Response> {
  const url = new URL(request.url)
  const fileId = uuid.safeParse(url.pathname.split('/').at(-1))
  if (!fileId.success) return failure('Invalid file identifier.')
  if (request.method === 'GET') {
    const target = accessSchema.parse(await dependencies.authorize('access', { fileId: fileId.data }))
    const preview = url.searchParams.get('mode') === 'preview'
    if (preview && (!previewMimeTypes.has(target.mimeType)
      || (target.mimeType === 'text/plain' && target.sizeBytes > 1048576)
      || (target.mimeType !== 'text/plain' && target.sizeBytes > 26214400))) {
      return failure('This file type is available for download but cannot be previewed safely.', 415)
    }
    const stored = await dependencies.fetch(target.objectKey)
    if (!stored.ok || !stored.body) return failure('The protected file could not be loaded. Please try again.', 502)
    const headers = new Headers({
      'content-type': target.mimeType === 'text/plain' ? 'text/plain; charset=utf-8' : target.mimeType,
      'cache-control': 'private, no-store, max-age=0',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'",
      'content-disposition': `${preview ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(target.filename)}`,
      'cross-origin-resource-policy': 'same-origin',
      'referrer-policy': 'no-referrer',
    })
    return new Response(stored.body, { headers })
  }
  if (request.method !== 'PUT') return failure('Method not allowed.', 405)
  const conversationId = uuid.safeParse(url.searchParams.get('conversation'))
  if (!conversationId.success) return failure('Choose a conversation.')
  const parentId = url.searchParams.get('thread')
  if (parentId && !uuid.safeParse(parentId).success) return failure('Choose a valid thread.')
  await dependencies.authorize('authorize', { conversationId: conversationId.data })
  const bytes = await boundedSphereUpload(request)
  const filename = url.searchParams.get('filename') || ''
  const validated = dependencies.validate(bytes, filename, request.headers.get('content-type') || '')
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)
  const checksum = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  const metadata = { fileId: fileId.data, conversationId: conversationId.data, parentId, filename: validated.sanitizedFilename, mimeType: validated.detectedMimeType, sizeBytes: bytes.length, checksum }
  const operation = operationSchema.parse(await dependencies.operation('begin', metadata))
  if (operation.state === 'clean') return Response.json(operation)
  const objectKey = `${conversationId.data}/${fileId.data}`
  try {
    // The file becomes shareable only after a durable read-back verifies the
    // exact private object. A matching pre-existing object remains a safe
    // idempotent retry when the initial storage write reports a conflict.
    try { await dependencies.store(objectKey, bytes, validated.detectedMimeType) } catch { /* verify the existing object below */ }
    await verifyStoredSphereFile(
      await dependencies.fetch(objectKey),
      bytes.byteLength,
      checksum,
    )
    const result = operationSchema.parse(await dependencies.operation('complete', { ...metadata, state: 'clean' }))
    return Response.json(result, { headers: { 'cache-control': 'private, no-store' } })
  } catch {
    await dependencies.operation('complete', { ...metadata, state: 'error' }).catch(() => undefined)
    return failure('The file could not be stored safely. Retry your upload.', 503)
  }
}
