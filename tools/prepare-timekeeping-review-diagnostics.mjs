import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const stages = [
  ['10-effective-events', 'private.get_effective_time_events', 'set'],
  ['20-effective-occurrences', 'private.get_effective_time_events_with_occurrence', 'set'],
  ['30-effective-categories', 'private.get_effective_time_event_payroll_categories', 'set'],
  ['40-review-base', 'private.get_timekeeping_review_base', 'object'],
  ['50-review-operations', 'private.get_timekeeping_review_operations_base', 'object'],
  ['60-review-payroll-assignment', 'private.get_timekeeping_review_preferred_name_boundary_base', 'object'],
  ['70-review-legal-names', 'private.get_timekeeping_review_salary_payroll_boundary_base', 'object'],
  ['80-review-hourly-boundary', 'private.get_timekeeping_review_pre_payroll_category', 'object'],
  ['90-category-map', 'public.get_time_payroll_category_map', 'array'],
  ['100-review-category', 'private.get_timekeeping_review_pre_payroll_week_allocation', 'object'],
  ['110-review-allocation', 'public.get_timekeeping_review', 'object'],
]

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value ?? '')
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
}

const actorContext = `do $diagnostic_actor$
declare
  actor_auth_id uuid;
begin
  select account.auth_user_id into actor_auth_id
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  where employee.status = 'active'
    and account.auth_user_id is not null
    and account.disabled_at is null
    and 'time.view' = any(private.employee_effective_permissions(employee.id))
  order by case employee.role when 'admin' then 0 else 1 end, employee.created_at
  limit 1;

  if actor_auth_id is null then
    raise insufficient_privilege using message = 'No existing active Time viewer is available for this operator diagnostic.';
  end if;

  perform set_config('request.jwt.claim.sub', actor_auth_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', actor_auth_id, 'role', 'authenticated', 'aal', 'aal2'
  )::text, true);
end
$diagnostic_actor$;`

function transaction(body, { actor = true } = {}) {
  return `-- Operator-only diagnostic. Run this file independently; never batch/retry it automatically.
begin read only;
set local statement_timeout = '6s';
set local lock_timeout = '250ms';
set local idle_in_transaction_session_timeout = '10s';
${actor ? `${actorContext}\n` : ''}
${body}
rollback;
`
}

export function buildTimekeepingDiagnostics(fromDate, throughDate) {
  if (!validDate(fromDate) || !validDate(throughDate) || throughDate < fromDate
    || Date.parse(throughDate) - Date.parse(fromDate) > 45 * 86400000) {
    throw new Error('Supply an observed, valid --from/--through range of at most 46 days.')
  }

  const files = new Map()
  const signatures = stages.map(([, fn, shape]) => `'${fn}(${shape === 'set' ? 'uuid' : 'date,date'})'`).join(',\n    ')
  files.set('00-catalog.sql', transaction(`with expected(signature) as (
  values ${stages.map(([, fn, shape]) => `('${fn}(${shape === 'set' ? 'uuid' : 'date,date'})')`).join(',\n    ')}
)
select expected.signature,
  function.oid is not null as installed,
  case when function.oid is not null then md5(pg_get_functiondef(function.oid)) end as source_md5,
  function.prosecdef as security_definer,
  function.provolatile as volatility,
  coalesce(function.proconfig @> array['search_path=""']::text[], false) as empty_search_path,
  current_setting('transaction_read_only') as transaction_read_only,
  current_setting('statement_timeout') as statement_timeout,
  current_setting('jit') as jit
from expected
left join pg_catalog.pg_proc function on function.oid = to_regprocedure(expected.signature)
order by expected.signature;`, { actor: false }))

  for (const [name, fn, shape] of stages) {
    const call = shape === 'set' ? `${fn}(null::uuid)` : `${fn}(date '${fromDate}', date '${throughDate}')`
    const body = shape === 'set'
      ? `with started as materialized (
  select clock_timestamp() as started_at
), measured as materialized (
  select count(*) as row_count
  from started cross join lateral ${call} event
)
select '${name}' as stage,
  '${fromDate}' as requested_from, '${throughDate}' as requested_through,
  round(extract(epoch from clock_timestamp() - started.started_at) * 1000, 3) as elapsed_ms,
  measured.row_count,
  current_setting('transaction_read_only') as transaction_read_only
from started cross join measured;`
      : `with started as materialized (
  select clock_timestamp() as started_at
), measured as materialized (
  select ${call} as payload from started
)
select '${name}' as stage,
  '${fromDate}' as requested_from, '${throughDate}' as requested_through,
  round(extract(epoch from clock_timestamp() - started.started_at) * 1000, 3) as elapsed_ms,
  jsonb_array_length(${shape === 'array' ? 'measured.payload' : "coalesce(measured.payload -> 'rows', '[]'::jsonb)"}) as row_count,
  octet_length(measured.payload::text) as payload_bytes,
  md5(measured.payload::text) as payload_md5,
  current_setting('transaction_read_only') as transaction_read_only
from started cross join measured;`
    files.set(`${name}.sql`, transaction(body))
  }

  files.set('README.txt', `Timekeeping review diagnostics — PREPARED, NOT EXECUTED

Observed request range supplied by operator: ${fromDate} through ${throughDate}.
Do not describe this range as the timeout reproduction unless it matches recovered request evidence.

Run 00-catalog.sql first through the approved operator SQL connection. It returns source fingerprints,
not function bodies. Compare live definitions privately with the owning source tree before proposing changes.
The remaining files are cumulative stage profiles, not independent performance contributions.
The effective-event stages deliberately measure the full history used by the existing implementations.
The public review and category-map stages use the supplied range. Run files one at a time, from the
smallest needed upstream stage. Never concatenate these files into a purported rollback regression.

Every SQL file has one BEGIN READ ONLY, a six-second per-statement timeout, a 250ms lock timeout,
and one final ROLLBACK. There is no schema, row, permission, migration-ledger, payroll, or audit write.
Existing Time access is evaluated using an operator transaction-local AAL2 request context; this is
diagnostic impersonation, not proof of a real employee session or the browser authorization boundary.
The scripts return only stage names, dates, durations, counts, payload sizes, and one-way digests.
They never return request claims, employee identifiers, payroll rows, names, email, or event details.
Do not enable statement parameter logging, add service credentials, increase these timeouts, retry a
timed-out stage automatically, or continue load probes while health/readiness or connection pressure degrades.
If the SQL transport drops after an error, close the connection; the idle transaction timeout also bounds it.

EXPLAIN is still required before a fix is approved. EXPLAIN SELECT function(...) shows only the outer
function scan/result, not PL/pgSQL's expensive nested statements. After identifying a slow stage, inspect
its exact live pg_get_functiondef privately and EXPLAIN the nested statement with the observed range and
the same rules/authorization context. Use EXPLAIN without ANALYZE first; any later ANALYZE must remain
read-only, time bounded, and healthy-system-only. Do not infer an index or rewrite from outer-function cost.

Required release regressions for a proven change:
- payroll_week_elapsed_time_allocation_regression.sql
- event_payroll_classification_regression.sql
- team_attendance_overnight_summary_regression.sql
- team_attendance_overtime_canonical_parity_regression.sql
- applicable occurrence identity, multi-segment, correction, authorization, and locked-history SQL suites
- focused payrollBoundary/payrollAllocations/payrollHoursConsistencyRegression and data/timekeeping tests
- pnpm check; actual-component tests/e2e/time-clock-workflow.spec.ts; fresh production build afterward
- real protected AAL2 review request for the observed range, current period, adjacent period, and maximum range

Rehearse each proposed migration and its SQL suites within exactly one outer BEGIN and final ROLLBACK,
with no COMMIT. Capture before/after row counts and canonical/locked-history hashes. Preserve exact payroll
allocation, categories, overtime, exception fingerprints/readiness, permission, MFA, active clock, and urgent
call-off behavior. After any verified deployment compare same-window timeout/error signatures and health.

Expected function signatures (no source replacement is authorized by this bundle):
${signatures}
`)
  return files
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((item) => {
    const match = /^--(from|through|out)=(.+)$/.exec(item)
    if (!match) throw new Error('Usage: node tools/prepare-timekeeping-review-diagnostics.mjs --from=YYYY-MM-DD --through=YYYY-MM-DD --out=<directory>')
    return [match[1], match[2]]
  }))
  if (!args.out) throw new Error('An explicit --out directory is required.')
  const files = buildTimekeepingDiagnostics(args.from, args.through)
  const output = resolve(args.out)
  await mkdir(output, { recursive: false })
  for (const [name, content] of files) await writeFile(join(output, name), content, { encoding: 'utf8', flag: 'wx' })
  process.stdout.write(`Prepared ${files.size} diagnostic files in ${output}; no database connection was made.\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
