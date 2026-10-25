#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { releaseOutcomes, runProductionRelease } from './production-release-core.mjs'
import { requireDatabaseReleaseBaseline } from './database-release-gate.mjs'

const root = resolve(import.meta.dirname, '..')

export function parseProductionReleaseArguments(commandLine) {
  const options = {
    dryRun: false,
    rollbackSafe: false,
    tag: '',
  }
  for (const argument of commandLine) {
    if (argument === '--') continue
    else if (argument === '--dry-run') options.dryRun = true
    else if (argument === '--rollback-safe') options.rollbackSafe = true
    else if (argument === '--allow-boundary-probe') options.allowBoundaryProbe = true
    else if (argument === '--maintenance-coordinated') options.maintenanceCoordinated = true
    else if (argument.startsWith('--candidate-alias=')) options.candidateAlias = argument.slice('--candidate-alias='.length)
    else if (argument.startsWith('--maintenance-window-id=')) options.maintenanceWindowId = argument.slice('--maintenance-window-id='.length)
    else if (argument.startsWith('--tag=')) options.tag = argument.slice('--tag='.length)
    else if (argument.startsWith('--message=')) options.message = argument.slice('--message='.length)
    else throw new Error('Unsupported release argument.')
  }
  if (!options.tag) throw new Error('Provide a safe release tag with --tag=<commit-or-release-tag>.')
  return options
}

function repositoryConfiguration() {
  const configuration = JSON.parse(readFileSync(resolve(root, 'wrangler.jsonc'), 'utf8'))
  return {
    productionOrigin: process.env.SYGSHIFT_RELEASE_PRODUCTION_ORIGIN || configuration.vars?.SYGSHIFT_PUBLIC_APP_URL,
    publishableKey: process.env.SYGSHIFT_RELEASE_SUPABASE_PUBLISHABLE_KEY
      || configuration.vars?.SUPABASE_PUBLISHABLE_KEY,
    supabaseOrigin: process.env.SYGSHIFT_RELEASE_SUPABASE_URL || configuration.vars?.SUPABASE_URL,
  }
}

export async function executeProductionRelease(options, injected = {}) {
  const migrationGate = injected.migrationGate ?? requireDatabaseReleaseBaseline
  const release = injected.release ?? runProductionRelease
  const log = injected.log ?? (() => undefined)
  const databaseBaseline = await migrationGate(options)
  if (databaseBaseline?.accepted !== true || databaseBaseline.freshProductionLedger !== true) {
    throw new Error('The mandatory database release gate did not confirm a fresh reviewed baseline.')
  }
  log(`Verified the fresh production ledger and owning sources against the reviewed baseline (${databaseBaseline.appliedMigrations} applied versions).`)
  return release(options, { log })
}

async function main() {
  const arguments_ = parseProductionReleaseArguments(process.argv.slice(2))
  const result = await executeProductionRelease({
    ...repositoryConfiguration(),
    ...arguments_,
    canaryEmail: process.env.SYGSHIFT_RELEASE_CANARY_EMAIL,
    canaryPassword: process.env.SYGSHIFT_RELEASE_CANARY_PASSWORD,
    cwd: root,
    expectedCanaryUsername: process.env.SYGSHIFT_RELEASE_CANARY_USERNAME,
    environment: process.env,
  }, {
    log: (message) => console.log(message),
  })

  console.log(JSON.stringify(result, null, 2))
  if (![releaseOutcomes.dryRun, releaseOutcomes.released].includes(result.outcome)) process.exitCode = 1
}

const directExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (directExecution) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'The production release failed.')
    process.exitCode = 1
  })
}
