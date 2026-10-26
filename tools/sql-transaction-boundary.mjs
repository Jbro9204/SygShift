function dollarQuoteAt(source, index) {
  if (source[index] !== '$') return null
  const match = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(source.slice(index))
  return match?.[0] ?? null
}

function isBackslashEscaped(source, index) {
  let count = 0
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) count += 1
  return count % 2 === 1
}

function scanTopLevelStatements(source) {
  const normalized = source.replace(/^\uFEFF/u, '')
  const statements = []
  let start = 0
  let index = 0
  let singleQuoted = false
  let doubleQuoted = false
  let dollarQuote = null
  let lineComment = false
  let blockCommentDepth = 0

  while (index < normalized.length) {
    const character = normalized[index]
    const next = normalized[index + 1]

    if (lineComment) {
      if (character === '\n' || character === '\r') lineComment = false
      index += 1
      continue
    }
    if (blockCommentDepth > 0) {
      if (character === '/' && next === '*') {
        blockCommentDepth += 1
        index += 2
      } else if (character === '*' && next === '/') {
        blockCommentDepth -= 1
        index += 2
      } else {
        index += 1
      }
      continue
    }
    if (dollarQuote) {
      if (normalized.startsWith(dollarQuote, index)) {
        index += dollarQuote.length
        dollarQuote = null
      } else {
        index += 1
      }
      continue
    }
    if (singleQuoted) {
      if (character === "'" && next === "'") {
        index += 2
      } else if (character === "'" && !isBackslashEscaped(normalized, index)) {
        singleQuoted = false
        index += 1
      } else {
        index += 1
      }
      continue
    }
    if (doubleQuoted) {
      if (character === '"' && next === '"') {
        index += 2
      } else if (character === '"') {
        doubleQuoted = false
        index += 1
      } else {
        index += 1
      }
      continue
    }

    if (character === '-' && next === '-') {
      lineComment = true
      index += 2
      continue
    }
    if (character === '/' && next === '*') {
      blockCommentDepth = 1
      index += 2
      continue
    }
    if (character === "'") {
      singleQuoted = true
      index += 1
      continue
    }
    if (character === '"') {
      doubleQuoted = true
      index += 1
      continue
    }
    const openingDollarQuote = dollarQuoteAt(normalized, index)
    if (openingDollarQuote) {
      dollarQuote = openingDollarQuote
      index += openingDollarQuote.length
      continue
    }
    if (character === ';') {
      statements.push({ start, end: index + 1, source: normalized.slice(start, index + 1) })
      start = index + 1
    }
    index += 1
  }

  if (singleQuoted || doubleQuoted || dollarQuote || blockCommentDepth > 0) {
    throw new Error('SQL source contains an unterminated quoted value or comment')
  }
  if (start < normalized.length) {
    statements.push({ start, end: normalized.length, source: normalized.slice(start) })
  }
  return { normalized, statements }
}

function stripComments(source) {
  let result = ''
  let index = 0
  let singleQuoted = false
  let doubleQuoted = false
  let dollarQuote = null
  let lineComment = false
  let blockCommentDepth = 0

  while (index < source.length) {
    const character = source[index]
    const next = source[index + 1]
    if (lineComment) {
      if (character === '\n' || character === '\r') {
        lineComment = false
        result += character
      } else {
        result += ' '
      }
      index += 1
      continue
    }
    if (blockCommentDepth > 0) {
      if (character === '/' && next === '*') {
        blockCommentDepth += 1
        result += '  '
        index += 2
      } else if (character === '*' && next === '/') {
        blockCommentDepth -= 1
        result += '  '
        index += 2
      } else {
        result += character === '\n' || character === '\r' ? character : ' '
        index += 1
      }
      continue
    }
    if (dollarQuote) {
      if (source.startsWith(dollarQuote, index)) {
        result += dollarQuote
        index += dollarQuote.length
        dollarQuote = null
      } else {
        result += character
        index += 1
      }
      continue
    }
    if (singleQuoted) {
      result += character
      if (character === "'" && next === "'") {
        result += next
        index += 2
      } else if (character === "'" && !isBackslashEscaped(source, index)) {
        singleQuoted = false
        index += 1
      } else {
        index += 1
      }
      continue
    }
    if (doubleQuoted) {
      result += character
      if (character === '"' && next === '"') {
        result += next
        index += 2
      } else if (character === '"') {
        doubleQuoted = false
        index += 1
      } else {
        index += 1
      }
      continue
    }
    if (character === '-' && next === '-') {
      lineComment = true
      result += '  '
      index += 2
      continue
    }
    if (character === '/' && next === '*') {
      blockCommentDepth = 1
      result += '  '
      index += 2
      continue
    }
    if (character === "'") singleQuoted = true
    else if (character === '"') doubleQuoted = true
    else {
      const openingDollarQuote = dollarQuoteAt(source, index)
      if (openingDollarQuote) {
        dollarQuote = openingDollarQuote
        result += openingDollarQuote
        index += openingDollarQuote.length
        continue
      }
    }
    result += character
    index += 1
  }
  return result
}

function boundaryKeyword(statement) {
  const significant = stripComments(statement.source).trim()
  const match = /^(begin|commit|rollback)\s*;$/iu.exec(significant)
  return match?.[1]?.toLowerCase() ?? null
}

function significantStatements(source) {
  const scanned = scanTopLevelStatements(source)
  return {
    normalized: scanned.normalized,
    statements: scanned.statements.filter((statement) => stripComments(statement.source).trim() !== ''),
  }
}

export function unwrapTransaction(source, expectedEnding, label = 'SQL source') {
  const { normalized, statements } = significantStatements(source)
  if (statements.length < 3) throw new Error(`${label}: transaction body must not be empty`)
  const boundaries = statements
    .map((statement, index) => ({ index, keyword: boundaryKeyword(statement) }))
    .filter(({ keyword }) => keyword)
  if (boundaries.length !== 2 || boundaries[0].index !== 0 || boundaries[0].keyword !== 'begin') {
    throw new Error(`${label}: expected exactly one outer BEGIN and no nested top-level transaction boundary`)
  }
  const finalBoundary = boundaries[1]
  if (finalBoundary.index !== statements.length - 1 || finalBoundary.keyword !== expectedEnding) {
    throw new Error(`${label}: expected final ${expectedEnding.toUpperCase()} and no nested top-level transaction boundary`)
  }
  const body = normalized.slice(statements[0].end, statements.at(-1).start).trim()
  if (!body) throw new Error(`${label}: transaction body must not be empty`)
  return body
}

export function validateGeneratedTransaction(sql, expectedEnding, label = 'generated SQL') {
  const { statements } = significantStatements(sql)
  const boundaries = statements
    .map((statement, index) => ({ index, keyword: boundaryKeyword(statement) }))
    .filter(({ keyword }) => keyword)
  if (
    boundaries.length !== 2
    || boundaries[0].index !== 0
    || boundaries[0].keyword !== 'begin'
    || boundaries[1].index !== statements.length - 1
    || boundaries[1].keyword !== expectedEnding
  ) {
    throw new Error(`${label}: expected one outer BEGIN and one final ${expectedEnding.toUpperCase()}`)
  }
}
