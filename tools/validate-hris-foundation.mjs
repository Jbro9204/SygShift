import { readFile } from 'node:fs/promises'
import process from 'node:process'

const configUrl = new URL('../config/hris-foundation-boundaries.json', import.meta.url)
const config = JSON.parse(await readFile(configUrl, 'utf8'))
const failures = []

const requireValue = (condition, message) => {
  if (!condition) failures.push(message)
}

const unique = (values) => new Set(values).size === values.length
const knownClassifications = new Set(config.classifications.map(({ code }) => code))

requireValue(config.releaseGate?.defaultEnabled === false, 'The HRIS release gate must default to disabled.')
requireValue(config.releaseGate?.protectedProductionDataAllowed === false, 'Protected HR production data must remain blocked during Stage 1.')
requireValue(config.releaseGate?.requiredEvidence?.length >= 5, 'The release gate must require security, recovery, and rollback evidence.')
requireValue(config.securityDefaults?.authorization === 'deny_by_default', 'HRIS authorization must deny by default.')
requireValue(config.securityDefaults?.serverEnforced === true, 'Server authorization is required.')
requireValue(config.securityDefaults?.databaseEnforced === true, 'Database authorization is required.')
requireValue(config.securityDefaults?.directObjectAccessDenied === true, 'Direct object access must be denied.')
requireValue(config.securityDefaults?.listDefaultPageSize <= 10, 'Default HRIS lists must remain compact.')
requireValue(config.securityDefaults?.listMaximumPageSize <= 100, 'Server pagination must cap list sizes.')
requireValue(config.securityDefaults?.recentMfaMinutes > 0, 'A recent-MFA window is required.')
requireValue(config.securityDefaults?.auditMode === 'append_only', 'HR audit history must be append-only.')

const breakGlass = config.securityDefaults?.breakGlass
requireValue(breakGlass?.enabledByDefault === false, 'Break-glass access must be disabled by default.')
requireValue(breakGlass?.maximumMinutes <= 60, 'Break-glass access must expire in 60 minutes or less.')
requireValue(breakGlass?.requiresRecentMfa && breakGlass?.requiresReason && breakGlass?.requiresSecondPersonReview && breakGlass?.audited, 'Break-glass access must require recent MFA, a reason, second-person review, and an audit record.')

requireValue(config.authoritativeDomains?.length >= 8, 'Every existing employee and HR domain must have an authoritative owner.')
requireValue(unique(config.authoritativeDomains.map(({ domain }) => domain)), 'Authoritative domain codes must be unique.')

requireValue(config.modules?.length >= 10, 'All approved HRIS program areas must be declared.')
requireValue(unique(config.modules.map(({ code }) => code)), 'HRIS module codes must be unique.')
requireValue(unique(config.modules.map(({ featureFlag }) => featureFlag)), 'Every HRIS module must have its own feature flag.')

for (const module of config.modules) {
  requireValue(knownClassifications.has(module.classification), `Module ${module.code} uses an unknown classification.`)
  requireValue(Boolean(module.readPermission && module.writePermission && module.sensitivePermission), `Module ${module.code} must declare read, write, and sensitive permissions.`)
  requireValue(module.recentMfaForWrites === true, `Module ${module.code} must require recent MFA for protected writes.`)
  requireValue(module.auditActions?.length >= 4, `Module ${module.code} must declare material audit actions.`)
  requireValue(module.featureFlag?.startsWith('hris_'), `Module ${module.code} must use a dedicated HRIS feature flag.`)
}

requireValue(config.vaults?.length >= 6, 'General, financial, identity, medical, disciplinary, and legal/safety vaults are required.')
requireValue(unique(config.vaults.map(({ code }) => code)), 'HRIS vault codes must be unique.')
for (const vault of config.vaults) {
  requireValue(vault.private === true, `Vault ${vault.code} must be private.`)
  requireValue(knownClassifications.has(vault.classification), `Vault ${vault.code} uses an unknown classification.`)
  requireValue(Boolean(vault.readPermission && vault.writePermission), `Vault ${vault.code} must declare separate read and write permissions.`)
}

for (const control of [
  'quarantineRequired',
  'malwareScanRequired',
  'signatureValidationRequired',
  'mimeValidationRequired',
  'extensionValidationRequired',
  'shortLivedAccessRequired',
  'immutableVersions',
  'retentionPolicyRequired',
  'legalHoldSupported',
  'previewAudited',
  'downloadAudited',
]) {
  requireValue(config.documentControls?.[control] === true, `Document control ${control} is required.`)
}
requireValue(config.documentControls?.publicAccess === false, 'HR documents cannot be public.')
requireValue(config.documentControls?.directStorageUrls === false, 'Direct HR document storage URLs are prohibited.')

if (failures.length > 0) {
  console.error('HRIS Stage 1 foundation validation failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.info(`HRIS Stage 1 foundation validated: ${config.modules.length} modules, ${config.authoritativeDomains.length} authoritative domains, ${config.vaults.length} protected vaults.`)
