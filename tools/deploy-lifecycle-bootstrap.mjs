#!/usr/bin/env node

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runLifecycleBootstrapDeployment } from './lifecycle-bootstrap-core.mjs'

const root = resolve(import.meta.dirname, '..')

export function parseLifecycleBootstrapArguments(commandLine) {
  const options = {
    confirmed: false,
    dryRun: false,
  }
  for (const argument of commandLine) {
    if (argument === '--') continue
    else if (argument === '--confirm-lifecycle-bootstrap') options.confirmed = true
    else if (argument === '--dry-run') options.dryRun = true
    else if (argument.startsWith('--message=')) options.message = argument.slice('--message='.length)
    else throw new Error('Unsupported lifecycle deployment argument.')
  }
  if (!options.confirmed) {
    throw new Error('Lifecycle deployment requires --confirm-lifecycle-bootstrap.')
  }
  return options
}

async function main() {
  const arguments_ = parseLifecycleBootstrapArguments(process.argv.slice(2))
  const result = await runLifecycleBootstrapDeployment({
    ...arguments_,
    cwd: root,
    environment: process.env,
  }, {
    log: (message) => console.log(message),
  })
  console.log(JSON.stringify(result, null, 2))
  if (!result.deployed && !result.dryRun) process.exitCode = 2
}

const directExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (directExecution) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'The lifecycle deployment failed.')
    process.exitCode = 1
  })
}
