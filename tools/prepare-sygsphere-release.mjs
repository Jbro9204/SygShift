import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..')
const rehearsal = process.argv.includes('--rehearsal')
const names = ['20260907023825_sygsphere_messaging_foundation.sql', '20260907025451_sygsphere_private_attachments.sql']
const sections = names.map((name) => {
  const source = readFileSync(resolve(root, `supabase/migrations/${name}`), 'utf8').trim()
  if (!/^begin;/i.test(source) || !/commit;$/i.test(source) || source.includes('$sygsphere_source$')) throw new Error('Unexpected migration shape')
  const body = source.replace(/^begin;/i, '').replace(/commit;$/i, '')
  if (/\b(?:begin|commit|rollback)\s*;/i.test(body)) throw new Error('Nested migration transaction')
  const version = name.split('_')[0]
  const label = name.slice(version.length + 1, -4)
  return `${body}\ninsert into supabase_migrations.schema_migrations(version,name,statements) values('${version}','${label}',array[$sygsphere_source$${body}$sygsphere_source$]);`
})
const sql = `begin;
set local lock_timeout='5s';
create temporary table sygsphere_preservation on commit drop as
select oid,md5(pg_get_functiondef(oid)) fingerprint from pg_proc where pronamespace in ('public'::regnamespace,'private'::regnamespace) and prokind='f';
${sections.join('\n')}
do $$ begin
  if exists(select 1 from sygsphere_preservation before left join pg_proc after on after.oid=before.oid where after.oid is null or md5(pg_get_functiondef(after.oid))<>before.fingerprint) then
    raise exception 'Existing operational function changed during SygSphere installation';
  end if;
  if exists(select 1 from pg_tables where schemaname='private' and tablename like 'sygsphere_%' and not rowsecurity) then raise exception 'SygSphere RLS missing'; end if;
end $$;
select version,name from supabase_migrations.schema_migrations where version in ('20260907023825','20260907025451') order by version;
${rehearsal ? "select 'Exact release preservation and history assertions passed; rolling back' result;\nrollback;" : 'commit;'}
`
mkdirSync(resolve(root, 'tmp'), { recursive: true })
writeFileSync(resolve(root, rehearsal ? 'tmp/sygsphere-release-rehearsal.sql' : 'tmp/sygsphere-release.sql'), sql)
console.log(`Prepared exact two-migration ${rehearsal ? 'rollback-only rehearsal' : 'release'} with atomic history registration, existing-function preservation assertions, and the SygSphere gate still disabled.`)
