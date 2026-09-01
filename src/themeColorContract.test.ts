import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const sourceRoot = join(process.cwd(), 'src')
const themeAwareFiles = ['App.css', 'index.css']
const themeSource = readFileSync(join(sourceRoot, 'theme.css'), 'utf8')

function relativeLuminance(hex: string) {
  const value = hex.slice(1)
  const expanded = value.length === 3
    ? value.split('').map((channel) => channel + channel).join('')
    : value.slice(0, 6)
  const channels = [0, 2, 4].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16) / 255)
  const linear = channels.map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

function withoutFunction(value: string, functionName: string) {
  let output = value
  let start = output.indexOf(`${functionName}(`)
  while (start >= 0) {
    let depth = 0
    let end = start
    for (; end < output.length; end += 1) {
      if (output[end] === '(') depth += 1
      if (output[end] === ')') {
        depth -= 1
        if (depth === 0) {
          end += 1
          break
        }
      }
    }
    output = `${output.slice(0, start)}${output.slice(end)}`
    start = output.indexOf(`${functionName}(`)
  }
  return output
}

function directLightBackgrounds(source: string) {
  const issues: string[] = []
  const declarations = source.matchAll(/\bbackground(?:-color)?\s*:\s*([^;]+);/gms)
  for (const declaration of declarations) {
    const value = declaration[1]
    const withoutThemePairs = withoutFunction(value, 'light-dark')
    for (const match of withoutThemePairs.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      if (relativeLuminance(match[0]) >= 0.72) issues.push(value.trim())
    }
    for (const match of withoutThemePairs.matchAll(/rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/g)) {
      const red = Number(match[1])
      const green = Number(match[2])
      const blue = Number(match[3])
      const alpha = match[4]?.endsWith('%') ? Number(match[4].slice(0, -1)) / 100 : Number(match[4] ?? 1)
      if (Math.min(red, green, blue) >= 225 && alpha >= 0.45) issues.push(value.trim())
    }
  }
  return issues
}

describe('system-wide theme color contract', () => {
  it('registers both explicit color schemes for compiled light-dark values', () => {
    expect(themeSource).toContain("html[data-theme='light']")
    expect(themeSource).toContain('color-scheme: light')
    expect(themeSource).toContain("html[data-theme='dark']")
    expect(themeSource).toContain('color-scheme: dark')
  })

  it.each(themeAwareFiles)('%s does not introduce a light-only application surface', (file) => {
    const source = readFileSync(join(sourceRoot, file), 'utf8')
    expect(directLightBackgrounds(source)).toEqual([])
  })
})
