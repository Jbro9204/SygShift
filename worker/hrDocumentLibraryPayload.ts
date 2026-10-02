interface HrDocumentLibraryPayloadWithItems {
  items?: unknown[]
}

const timezoneQualifiedTimestampPattern = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u

function withoutUpdatedAt(item: Record<string, unknown>): Record<string, unknown> {
  const { updatedAt: _updatedAt, ...remaining } = item
  return remaining
}

/**
 * PostgreSQL serializes UTC timestamptz values with a +00:00 suffix. Preserve
 * the complete fractional-second value while presenting the equivalent Z form
 * expected by older cached Document Center clients.
 */
export function normalizeHrDocumentLibraryTimestamps<T extends HrDocumentLibraryPayloadWithItems>(payload: T): T {
  if (!Array.isArray(payload.items)) return payload

  const items = payload.items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    const record = item as Record<string, unknown>
    if (typeof record.updatedAt !== 'string') return withoutUpdatedAt(record)

    const updatedAt = record.updatedAt.trim()
    if (!isHrDocumentSourceVersionTimestamp(updatedAt)) return withoutUpdatedAt(record)

    const canonical = updatedAt.replace(/[+-]00:00$/u, 'Z')
    return canonical === record.updatedAt ? item : { ...record, updatedAt: canonical }
  })

  return Object.assign({}, payload, { items })
}

/**
 * Validates an exact source-version token without converting it through a
 * JavaScript Date. Conversion would truncate PostgreSQL microseconds and make
 * an unchanged source look stale during the database concurrency check.
 */
export function isHrDocumentSourceVersionTimestamp(value: string): boolean {
  return timezoneQualifiedTimestampPattern.test(value) && Number.isFinite(Date.parse(value))
}
