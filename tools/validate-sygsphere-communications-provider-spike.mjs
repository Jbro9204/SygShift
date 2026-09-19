#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const executeTurnCredentialCheck = process.argv.includes('--execute-turn-credential-check')
const contractManifest = JSON.parse(
  readFileSync(resolve(process.cwd(), 'shared/sygsphere-communications/v1/contract-manifest.json'), 'utf8'),
)

if (typeof contractManifest.contractVersion !== 'string' || contractManifest.contractVersion.length === 0) {
  throw new Error('The SygSphere Communications contract manifest is unavailable.')
}

const required = [
  'COMMS_SPIKE_ENVIRONMENT',
  'COMMS_SPIKE_CONFIRM_NON_PRODUCTION',
  'CF_TURN_KEY_ID',
  'CF_TURN_API_TOKEN',
]
const missing = required.filter((name) => !process.env[name]?.trim())
const report = {
  contractVersion: contractManifest.contractVersion,
  status: 'not-executed',
  checks: {
    stagingEnvironment: process.env.COMMS_SPIKE_ENVIRONMENT === 'staging',
    explicitNonProductionConfirmation: process.env.COMMS_SPIKE_CONFIRM_NON_PRODUCTION === 'I_UNDERSTAND_THIS_CREATES_STAGING_TURN_CREDENTIALS',
    turnCredentialsConfigured: !missing.includes('CF_TURN_KEY_ID') && !missing.includes('CF_TURN_API_TOKEN'),
    realTwoDeviceAudio: false,
    forcedProviderClosure: false,
    idleRebuild: false,
    trackReuse: false,
    tlsTurn: false,
    camera: false,
    screenShare: false,
  },
  note: 'No provider behavior is validated until the staging-only command succeeds and the manual two-device matrix is recorded.',
}

if (!executeTurnCredentialCheck) {
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = 0
} else if (missing.length > 0 || !report.checks.stagingEnvironment || !report.checks.explicitNonProductionConfirmation) {
  console.error(JSON.stringify({ ...report, status: 'blocked', missing }, null, 2))
  process.exitCode = 2
} else {
  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(process.env.CF_TURN_KEY_ID)}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.CF_TURN_API_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ttl: 3600,
        customIdentifier: `sygsphere-stage1-${randomUUID()}`,
      }),
    },
  )

  if (!response.ok) {
    console.error(JSON.stringify({ ...report, status: 'failed', httpStatus: response.status }, null, 2))
    process.exitCode = 1
  } else {
    const payload = await response.json()
    const hasIceServers = Array.isArray(payload?.iceServers) && payload.iceServers.length > 0
    console.log(JSON.stringify({
      ...report,
      status: hasIceServers ? 'turn-credential-validated' : 'failed',
      checks: { ...report.checks, turnCredentialsConfigured: hasIceServers },
      returnedIceServerCount: hasIceServers ? payload.iceServers.length : 0,
      note: 'Credential material is intentionally omitted. Complete and record the manual two-device matrix before claiming provider validation.',
    }, null, 2))
    process.exitCode = hasIceServers ? 0 : 1
  }
}
