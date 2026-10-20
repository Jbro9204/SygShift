import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const thisFile = fileURLToPath(import.meta.url)

export function validateToolchain({
  nodeVersion = process.version,
  pnpmUserAgent = process.env.npm_config_user_agent,
} = {}) {
  const failures = []
  if (nodeVersion !== 'v24.19.0') {
    failures.push(`Node.js ${nodeVersion} is unsupported; SygShift requires Node.js 24.19.0.`)
  }
  if (typeof pnpmUserAgent !== 'string' || !/^pnpm\/11\.25\.0(?:\s|$)/u.test(pnpmUserAgent)) {
    failures.push('SygShift requires pnpm 11.25.0. Run pnpm self-update 11.25.0 before the release gate.')
  }
  return failures
}

async function main() {
  const packageJson = JSON.parse(await readFile(resolve(process.cwd(), 'package.json'), 'utf8'))
  const failures = validateToolchain()
  if (packageJson.packageManager !== 'pnpm@11.25.0') {
    failures.push('packageManager must pin pnpm@11.25.0.')
  }
  if (packageJson.engines?.node !== '24.19.0' || packageJson.engines?.pnpm !== '11.25.0') {
    failures.push('package.json engines must pin Node.js 24.19.0 and pnpm 11.25.0.')
  }
  if (failures.length) {
    throw new Error(`Toolchain validation failed:\n- ${failures.join('\n- ')}`)
  }
  console.log('Toolchain validation passed: Node.js 24.19.0 and pnpm 11.25.0.')
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(thisFile)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Toolchain validation failed.')
    process.exitCode = 1
  })
}
