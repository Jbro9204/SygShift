import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyRetryRepairSnapshot } from './verify-postgres-retry-repair.mjs'

const baseline = { migrationCount: 436, md5: 'original' }
const manifests = [{ ledgerBefore: baseline, functions: [{ identity: 'public.f()', beforeMd5: 'before', afterMd5: 'after', metadataMd5: 'security', sites: [{}] }], runtimeExceptions: [] }]
const ledger = (repairCount) => ({ total_count: 436 + repairCount, original_count: 436, original_md5: 'original', repair_count: repairCount })
test('before and after require exact effective bodies, metadata and ledger without mutating records', () => {
  assert.equal(verifyRetryRepairSnapshot({ phase: 'before', manifests, ledger: ledger(0), catalog: [{ identity: 'public.f()', definition_md5: 'before', metadata_md5: 'security', body: 'begin raise serialization_failure; end;' }] }).verifiedFunctions, 1)
  assert.equal(verifyRetryRepairSnapshot({ phase: 'after', manifests, ledger: ledger(1), catalog: [{ identity: 'public.f()', definition_md5: 'after', metadata_md5: 'security', body: "begin raise sqlstate 'PT409'; end;" }] }).securityMetadataUnchanged, true)
})
test('partial activation, unrelated ledger changes and privileged metadata changes fail closed', () => {
  const base = { phase: 'after', manifests, ledger: ledger(1), catalog: [{ identity: 'public.f()', definition_md5: 'after', metadata_md5: 'security', body: "begin raise sqlstate 'PT409'; end;" }] }
  assert.throws(() => verifyRetryRepairSnapshot({ ...base, ledger: ledger(0) }), /ledger drift/u)
  assert.throws(() => verifyRetryRepairSnapshot({ ...base, ledger: { ...ledger(1), original_md5: 'drift' } }), /ledger drift/u)
  assert.throws(() => verifyRetryRepairSnapshot({ ...base, catalog: [{ ...base.catalog[0], metadata_md5: 'changed' }] }), /fingerprint drift/u)
})
test('a new unsafe function outside the reviewed set prevents successful postflight', () => {
  assert.throws(() => verifyRetryRepairSnapshot({ phase: 'after', manifests, ledger: ledger(1), catalog: [
    { identity: 'public.f()', definition_md5: 'after', metadata_md5: 'security', body: "begin raise sqlstate 'PT409'; end;" },
    { identity: 'public.unreviewed()', definition_md5: 'bad', body: "begin raise sqlstate '40001'; end;" },
  ] }), /Production retry-safety gate refused/u)
})
