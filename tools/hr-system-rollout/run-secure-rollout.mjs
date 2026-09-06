import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(process.argv[2] ?? '')
const origin = (process.env.SYGSHIFT_HR_ROLLOUT_ORIGIN ?? 'https://app.sygilant.us').replace(/\/$/, '')
const secret = process.env.SYGSHIFT_HR_ROLLOUT_SECRET?.trim() ?? ''
if (!root || secret.length < 32) throw new Error('Provide the rollout directory and a one-time rollout secret.')

const catalog = JSON.parse(await readFile(resolve(root, 'catalog.json'), 'utf8'))
if (catalog?.libraryVersion !== '2.1' || catalog?.canonicalPdfCount !== 537 || catalog?.items?.length !== 537) {
  throw new Error('The controlled v2.1 catalog is invalid.')
}

function encodeMetadata(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function deterministicUploadId(checksum) {
  const value = checksum.slice(0, 32).split('')
  value[12] = '4'
  value[16] = ['8', '9', 'a', 'b'][Number.parseInt(value[16], 16) % 4]
  const joined = value.join('')
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`
}

async function request(path, init, attempts = 8) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${origin}${path}`, {
        ...init,
        headers: {
          ...init.headers,
          'x-sygshift-hr-rollout-secret': secret,
          'x-sygshift-hr-rollout-version': '2.1',
        },
      })
      if (response.ok) return response
      const detail = await response.text()
      if (response.status < 500 && response.status !== 429) throw new Error(`${response.status} ${detail}`)
      lastError = new Error(`${response.status} ${detail}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(15_000, 750 * 2 ** (attempt - 1))))
  }
  throw lastError ?? new Error('The rollout request failed.')
}

let completed = 0
const startCode = process.env.SYGSHIFT_HR_ROLLOUT_START_CODE?.trim() ?? ''
const startIndex = startCode ? catalog.items.findIndex((item) => item.code === startCode) : 0
if (startIndex < 0) throw new Error(`The requested resume code ${startCode} is not in the controlled catalog.`)
for (const item of catalog.items.slice(startIndex)) {
  const bytes = await readFile(resolve(root, item.pdfRelativePath))
  const checksum = createHash('sha256').update(bytes).digest('hex')
  if (bytes.byteLength !== item.sizeBytes || checksum !== item.sha256) {
    throw new Error(`${item.code} failed its local integrity check.`)
  }

  const uploadResponse = await request('/api/v1/internal/hr-system-rollout/upload', {
    body: bytes,
    headers: {
      'content-type': 'application/pdf',
      'x-sygshift-document-metadata': encodeMetadata({
        accessClassification: item.sensitivity,
        category: item.category.slice(0, 100),
        declaredMimeType: 'application/pdf',
        description: `${item.code} · ${item.purpose}`.slice(0, 2000),
        documentId: null,
        employeeId: null,
        idempotencyKey: deterministicUploadId(item.sha256),
        originalFilename: item.pdfRelativePath.split('/').at(-1),
        replacementReason: null,
        title: item.title.slice(0, 180),
        vaultCode: item.vaultCode,
      }),
    },
    method: 'PUT',
  })
  const upload = await uploadResponse.json()
  if (!upload.documentId) throw new Error(`${item.code} did not return a protected document identifier.`)

  await request('/api/v1/internal/hr-system-rollout/register', {
    body: JSON.stringify({
      category: item.category,
      code: item.code,
      documentId: upload.documentId,
      documentKind: item.kind,
      fullText: item.searchText.slice(0, 700_000),
      guideCode: item.guideCode ?? null,
      lifecycleStatus: item.status,
      packageMetadata: {
        libraryVersion: '2.1',
        pdfRelativePath: item.pdfRelativePath,
        sizeBytes: item.sizeBytes,
        sourceRelativePath: item.sourceRelativePath,
      },
      pageCount: item.pageCount,
      purpose: item.purpose,
      recordClass: item.recordClass,
      relatedModules: item.relatedModules,
      section: item.section,
      sensitivity: item.sensitivity === 'confidential' ? 'standard' : item.sensitivity,
      sourceFilename: item.pdfRelativePath.split('/').at(-1),
      sourceSha256: item.sha256,
      title: item.title,
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })

  completed += 1
  const catalogPosition = startIndex + completed
  if (catalogPosition % 10 === 0 || catalogPosition === catalog.items.length) {
    process.stdout.write(`Imported ${catalogPosition}/${catalog.items.length}\n`)
  }
}
