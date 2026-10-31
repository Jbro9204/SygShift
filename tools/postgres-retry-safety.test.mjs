import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findRetryRaises, applyReviewedRetryRepairs, assertRuntimeRetrySafety, assertReviewedFunctionFingerprints, checkMigrationRetrySafety, sha256 } from './postgres-retry-safety.mjs'

test('finds all explicit SQLSTATE forms without treating handler rethrows as new errors', () => {
  const source = `begin
    if stale then raise serialization_failure using message = 'Changed'; end if;
    raise exception using errcode = '40001', message = 'Stale';
    raise sqlstate '40P01' using message = 'Not a genuine deadlock';
    raise deadlock_detected;
    raise exception sqlstate '40001';
  exception when serialization_failure or deadlock_detected then raise; end;`
  const found = findRetryRaises(source)
  assert.deepEqual(found.map((value) => value.kind), ['condition', 'errcode', 'sqlstate', 'condition', 'sqlstate'])
  assert.equal(findRetryRaises(applyReviewedRetryRepairs(source, found)).length, 0)
  assert.match(applyReviewedRetryRepairs(source, found), /when serialization_failure or deadlock_detected then raise;/u)
})

test('comments, message literals, quoted identifiers and dynamic repair strings are inert', () => {
  const source = `-- raise serialization_failure;
  /* nested /* raise deadlock_detected; */ comments */
  select 'raise exception using errcode = ''40001'';', "raise";
  do $block$ begin old := $old$raise serialization_failure;$old$; end $block$;
  create function f() returns void as $f$ begin raise sqlstate 'PT409'; end $f$ language plpgsql;`
  assert.equal(findRetryRaises(source).length, 0)
})

test('function and DO bodies retain exact offsets and mixed case is detected', () => {
  const source = `create function f() returns void as $f$ BEGIN RAISE SQLSTATE '40001'; END $f$ language plpgsql; do $$begin raise serialization_failure; end$$;`
  const found = findRetryRaises(source)
  assert.equal(found.length, 2)
  assert.equal(source.slice(found[0].start, found[0].end), "'40001'")
  assert.match(applyReviewedRetryRepairs(source, found), /RAISE SQLSTATE 'PT409'/u)
})

test('dynamic error code fails closed and cannot be automatically rewritten', () => {
  const source = `begin raise exception using errcode = selected_code, message = 'Rejected'; end;`
  const findings = findRetryRaises(source)
  assert.equal(findings[0].kind, 'dynamic_errcode')
  assert.throws(() => applyReviewedRetryRepairs(source, findings), /explicit review/u)
  assert.throws(() => assertRuntimeRetrySafety([{ identity: 'public.f()', body: source, definition_md5: 'a' }]), /gate refused/u)
})

test('quoted SQL bodies are checked and escape-string message text is inert', () => {
  assert.equal(findRetryRaises("create function f() returns void as 'begin raise sqlstate ''40001''; end;' language plpgsql;").length, 1)
  assert.equal(findRetryRaises(String.raw`select E'quoted \\ content';`).length, 0)
  assert.equal(findRetryRaises(String.raw`select E'not a raise \' raise serialization_failure;';`).length, 0)
})

test('effective function checks reject changed body or security metadata independently', () => {
  const manifest = { functions: [{ identity: 'public.f()', afterMd5: 'after', metadataMd5: 'security' }] }
  const rows = [{ identity: 'public.f()', definition_md5: 'after', metadata_md5: 'security' }]
  assert.equal(assertReviewedFunctionFingerprints(rows, manifest).verifiedFunctions, 1)
  assert.throws(() => assertReviewedFunctionFingerprints([{ ...rows[0], metadata_md5: 'changed' }], manifest), /missing or changed/u)
  assert.throws(() => assertReviewedFunctionFingerprints([{ ...rows[0], definition_md5: 'before' }], manifest), /missing or changed/u)
  assert.throws(() => assertReviewedFunctionFingerprints([], manifest), /missing or changed/u)
})

test('a genuine reviewed engine-propagation exception is bound to a definition and justification', () => {
  const row = { identity: 'private.engine_adapter()', body: 'begin raise sqlstate \'40001\'; end;', definition_md5: 'reviewed' }
  assert.throws(() => assertRuntimeRetrySafety([row]), /gate refused/u)
  assert.equal(assertRuntimeRetrySafety([row], [{ identity: row.identity, definitionMd5: 'reviewed', justification: 'Test fixture for explicitly reviewed engine propagation' }]).unsafeFunctions, 0)
  assert.throws(() => assertRuntimeRetrySafety([row], [{ identity: row.identity, definitionMd5: 'changed', justification: 'old review' }]), /gate refused/u)
})

test('historical SQL is immutable; new or edited retry raises are refused', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'retry-safety-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'supabase/migrations'), { recursive: true })
  const old = 'do $$begin\n raise serialization_failure; end$$;'
  const path = 'supabase/migrations/01_old.sql'
  writeFileSync(join(root, path), old)
  const baseline = { formatVersion: 1, immutableHistoricalSources: [{ path, sha256: sha256(old) }] }
  assert.equal(checkMigrationRetrySafety(root, baseline).immutableSources, 1)
  writeFileSync(join(root, path), old.replaceAll('\n', '\r\n'))
  assert.equal(checkMigrationRetrySafety(root, baseline).immutableSources, 1)
  writeFileSync(join(root, 'supabase/migrations/02_new.sql'), old)
  assert.throws(() => checkMigrationRetrySafety(root, baseline), /require review/u)
  writeFileSync(join(root, 'supabase/migrations/02_new.sql'), "do $$begin raise sqlstate 'PT409'; end$$;")
  writeFileSync(join(root, path), old + ' -- edited')
  assert.throws(() => checkMigrationRetrySafety(root, baseline), /immutable retry-bearing migration changed/u)
})
