#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { relative, resolve, sep } from 'node:path'

export const viteSourceEntrypoint = 'src/main.tsx'
export const viteClientOutputDirectory = 'dist/client'

const isFile = (path) => existsSync(path) && statSync(path).isFile()
const isDirectory = (path) => existsSync(path) && statSync(path).isDirectory()

const moduleScriptSources = (html) => [...html.matchAll(/<script\b[^>]*>/gi)]
  .map((match) => match[0])
  .filter((tag) => /\btype\s*=\s*["']module["']/i.test(tag))
  .map((tag) => tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1])
  .filter((source) => typeof source === 'string')

const configuredAssetsDirectory = (configuration) => {
  const assets = configuration.match(/"assets"\s*:\s*\{([\s\S]*?)\}/)
  return assets?.[1].match(/"directory"\s*:\s*"([^"]+)"/)?.[1] ?? null
}

const pathWithin = (directory, candidate) => {
  const path = relative(directory, candidate)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.includes(`..${sep}`))
}

/**
 * Verifies only the build/asset handoff. It does not call Cloudflare, inspect
 * credentials, or mutate generated files. Keep it after `vite build` so a
 * stale or missing client entrypoint cannot be deployed through package scripts.
 */
export function validateStaticAssetContract(root = process.cwd()) {
  const failures = []
  const sourceIndexPath = resolve(root, 'index.html')
  const sourceEntrypointPath = resolve(root, viteSourceEntrypoint)
  const wranglerPath = resolve(root, 'wrangler.jsonc')
  const expectedAssetsDirectory = resolve(root, viteClientOutputDirectory)

  if (!isFile(sourceIndexPath)) {
    failures.push('Vite source index.html is missing.')
  } else {
    const sourceEntrypoints = moduleScriptSources(readFileSync(sourceIndexPath, 'utf8'))
    if (!sourceEntrypoints.includes(`/${viteSourceEntrypoint}`)) {
      failures.push(`Vite source index.html must load /${viteSourceEntrypoint} as its module entrypoint.`)
    }
  }
  if (!isFile(sourceEntrypointPath)) failures.push(`Vite source entrypoint ${viteSourceEntrypoint} is missing.`)

  let configuredDirectory = null
  if (!isFile(wranglerPath)) {
    failures.push('wrangler.jsonc is missing.')
  } else {
    configuredDirectory = configuredAssetsDirectory(readFileSync(wranglerPath, 'utf8'))
    if (!configuredDirectory) {
      failures.push('wrangler.jsonc must declare assets.directory.')
    } else if (resolve(root, configuredDirectory) !== expectedAssetsDirectory) {
      failures.push(`wrangler assets.directory must be ./${viteClientOutputDirectory}/ to match Vite output.`)
    }
  }

  if (!isDirectory(expectedAssetsDirectory)) {
    failures.push(`Vite client output directory ${viteClientOutputDirectory} is missing. Run pnpm build before deploy.`)
  } else {
    const builtIndexPath = resolve(expectedAssetsDirectory, 'index.html')
    if (!isFile(builtIndexPath)) {
      failures.push(`Vite client entrypoint ${viteClientOutputDirectory}/index.html is missing.`)
    } else {
      const builtEntrypoints = moduleScriptSources(readFileSync(builtIndexPath, 'utf8'))
      const entrypoint = builtEntrypoints.find((source) => source.startsWith('/assets/'))
      if (!entrypoint) {
        failures.push('Vite client index.html does not reference a built /assets/ module entrypoint.')
      } else {
        const builtAssetPath = resolve(expectedAssetsDirectory, `.${entrypoint}`)
        if (!pathWithin(expectedAssetsDirectory, builtAssetPath) || !isFile(builtAssetPath)) {
          failures.push(`Vite client module entrypoint ${entrypoint} is missing from the configured assets directory.`)
        }
      }
    }
  }

  return {
    assetsDirectory: configuredDirectory,
    failures,
    ok: failures.length === 0,
  }
}

const isDirectExecution = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectExecution) {
  const result = validateStaticAssetContract()
  if (!result.ok) {
    console.error('Static asset contract failed:')
    for (const failure of result.failures) console.error(`- ${failure}`)
    process.exitCode = 1
  } else {
    console.log(`Static asset contract passed: wrangler serves ${viteClientOutputDirectory}/ with a built Vite client entrypoint.`)
  }
}
