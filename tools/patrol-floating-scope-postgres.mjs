// Runs inside the native patrol PostgreSQL lifecycle's disposable loopback fixture.
export async function testFloatingPatrolScope({ sql, read, migrationBody, check, rejected, id, context, actor, guard, otherGuard,
  clientA, clientB, siteA, siteB, sourceShift, routeA, linkSignature, protectedSnapshot, holdTransaction, materialize, newShiftFor, publish }) {
  const migration = read('supabase/migrations/20261121203920_floating_patrol_shift_scope.sql')
  const floatingRpc = 'public.service_get_floating_patrol_scopes_v1(uuid,uuid[])'
  const floatingGet = 'public.get_floating_patrol_scope_v1(uuid,uuid)'
  const floatingSave = 'public.save_floating_patrol_scope_v1(uuid,uuid,uuid[],integer,text)'
  const floatingSiteAuth = 'private.floating_patrol_site_authorized_v1(uuid,uuid,uuid)'
  const floatingConfigured = 'private.floating_patrol_assignment_configured_v1(uuid,uuid)'
  sql(`begin;\n${migrationBody(migration)}\nrollback;`)
  check(sql(`select to_regprocedure('${floatingRpc}') is null`), 't', 'Floating scope safely rehearses without retaining the schema')
  const migrationBefore = protectedSnapshot(), nativeBefore = sql(`select md5(pg_get_functiondef('${linkSignature}'::regprocedure))`)
  sql(migration)
  check(protectedSnapshot(), migrationBefore, 'Floating migration leaves authoritative schedules, payroll, punches, routes and reports untouched')
  check(sql(`select md5(pg_get_functiondef('${linkSignature}'::regprocedure))`), nativeBefore, 'Fixed-route API body is unchanged')
  for (const role of ['anon', 'service_role', 'authenticated']) {
    for (const signature of [floatingRpc, floatingGet, floatingSave, floatingSiteAuth, floatingConfigured]) {
      const permitted = [floatingGet, floatingSave].includes(signature) ? 'authenticated' : 'service_role'
      check(sql(`select has_function_privilege('${role}','${signature}','execute')`), role === permitted ? 't' : 'f', `${signature}: exact role boundary for ${role}`)
    }
    for (const table of ['floating_patrol_scope_approvals', 'floating_patrol_scope_properties']) {
      check(sql(`select has_table_privilege('${role}','private.${table}','select,insert,update,delete,truncate')`), 'f', `Floating history is private even to ${role}`)
    }
  }

  const floatingShift = id(950), fixedShift = id(951), noClientSite = id(952), trainingShift = id(953), endedShift = id(954), unassignedShift = id(955)
  const serviceRole = "set request.jwt.claim.role='service_role';"
  const uuidArray = (values) => `array[${values.map((value) => `'${value}'::uuid`).join(',')}]::uuid[]`
  const saveScope = (shift, employee, sites, revision) => `public.save_floating_patrol_scope_v1('${shift}','${employee}',${uuidArray(sites)},${revision ?? 'null'},'Verified Operations property list')`
  const getScope = (shift, employee = guard) => JSON.parse(sql(context() + `select public.get_floating_patrol_scope_v1('${shift}','${employee}');`))
  const serviceScopes = (employee, shifts) => JSON.parse(sql(serviceRole + `select public.service_get_floating_patrol_scopes_v1('${employee}',${uuidArray(shifts)});`))
  const authorizeScope = (shift, employee, site) => sql(`select private.floating_patrol_site_authorized_v1('${employee}','${shift}','${site}');`)
  const save = (shift, employee, sites, revision) => JSON.parse(sql(context() + `select ${saveScope(shift, employee, sites, revision)};`))
  const floatingRow = (shift, employee, sites) => [{ shift_id: shift, employee_id: employee, site_ids: sites }]
  sql(`insert into public.sites (id,active) values('${noClientSite}',true);
    insert into public.shifts (id,schedule_id,post_id,starts_at,ends_at,time_zone,work_type,created_by)
    select requested.shift_id,s.schedule_id,s.post_id,
        case when requested.shift_id='${endedShift}' then now()-interval '2 hours' else s.starts_at + requested.ordinality * interval '1 minute' end,
        case when requested.shift_id='${endedShift}' then now()-interval '1 hour' else s.ends_at + requested.ordinality * interval '1 minute' end,
        s.time_zone,case when requested.shift_id='${trainingShift}' then 'training' else 'post' end,s.created_by
      from public.shifts s cross join unnest(${uuidArray([floatingShift, fixedShift, trainingShift, endedShift, unassignedShift])}) with ordinality as requested(shift_id,ordinality)
      where s.id='${sourceShift}';
    insert into public.shift_assignments(shift_id,employee_id,status,assigned_by)
      select requested.shift_id,'${guard}','confirmed','${actor}' from unnest(${uuidArray([floatingShift,fixedShift,trainingShift,endedShift])}) as requested(shift_id);
    insert into public.shift_assignments(shift_id,employee_id,status,assigned_by) values('${floatingShift}','${otherGuard}','confirmed','${actor}');`)
  const operationalBaseline = protectedSnapshot()
  check(getScope(floatingShift).status, 'not_configured', 'A staffed post is not inherently floating')
  rejected(`perform public.service_get_floating_patrol_scopes_v1('${guard}',${uuidArray([floatingShift])});`, '42501')
  rejected(context(guard) + `perform public.get_floating_patrol_scope_v1('${floatingShift}','${guard}');`, '42501')
  rejected(context(actor, false) + `perform ${saveScope(floatingShift, guard, [siteB], null)};`, '42501')
  rejected(context(guard) + `perform ${saveScope(floatingShift, guard, [siteB], null)};`, '42501')
  rejected(context() + `perform ${saveScope(trainingShift, guard, [siteB], null)};`, '22023')
  rejected(context() + `perform ${saveScope(endedShift, guard, [siteB], null)};`, '22023')
  rejected(context() + `perform ${saveScope(unassignedShift, guard, [siteB], null)};`, '22023')
  rejected(context() + `perform ${saveScope(floatingShift, guard, [noClientSite], null)};`, '22023')
  rejected(context() + `perform ${saveScope(floatingShift, guard, [siteB, siteB], null)};`, '22023')
  rejected(context() + `perform ${saveScope(floatingShift, guard, [], null)};`, '22023')
  check(save(floatingShift, guard, [siteB], null), {
    shiftId: floatingShift, employeeId: guard, revision: 1, approvedSiteIds: [siteB], siteIds: [siteB],
    configured: true, eligible: true, active: true, status: 'ready',
  }, 'Only the explicitly chosen property is approved, not the schedule anchor')
  check(serviceScopes(guard, [floatingShift, sourceShift, fixedShift, floatingShift]), floatingRow(floatingShift, guard, [siteB]), 'Service scope is deduplicated and leaves fixed/native routes alone')
  check(serviceScopes(otherGuard, [floatingShift]), [], 'A separately staffed guard does not inherit or lose their own scope')
  check(authorizeScope(floatingShift, guard, siteB), 't', 'Backend authorizes the approved property')
  check(authorizeScope(floatingShift, guard, siteA), 'f', 'Backend denies the unapproved anchor property')
  check(authorizeScope(floatingShift, otherGuard, siteB), 'f', 'Backend denies another guard’s approved property')
  check(authorizeScope(fixedShift, guard, siteB), 'f', 'Backend denies use of scope on another shift')
  rejected(context() + `perform ${saveScope(floatingShift, guard, [siteB], null)};`, 'PT409')
  rejected(context() + `perform public.link_patrol_route_shift('${routeA}','${floatingShift}','${guard}');`, 'PT409')
  check(protectedSnapshot(), operationalBaseline, 'Approval and failed route connection leave authoritative records untouched')

  const busySaveRelease = await holdTransaction(`select pg_advisory_xact_lock(hashtextextended('patrol:route-link:${floatingShift}:${guard}',0))`)
  try {
    rejected(`perform private.floating_patrol_assignment_configured_v1('${guard}','${floatingShift}');`, 'PT409')
    rejected(context() + `perform ${saveScope(floatingShift, guard, [siteA], 1)};`, 'PT409')
  } finally { await busySaveRelease() }
  const busyReportRelease = await holdTransaction(`select private.floating_patrol_site_authorized_v1('${guard}','${floatingShift}','${siteB}')`)
  try { rejected(context() + `perform ${saveScope(floatingShift, guard, [], 1)};`, 'PT409') }
  finally { await busyReportRelease() }

  sql(`update public.sites set client_id='${clientA}' where id='${siteB}';`)
  check(getScope(floatingShift).approvedSiteIds, [siteB], 'Client reassignment keeps the original reviewed property in the audit view')
  check(serviceScopes(guard, [floatingShift]), floatingRow(floatingShift, guard, []), 'Changed client removes authority and does not fall back to the anchor')
  check(authorizeScope(floatingShift, guard, siteB), 'f', 'Report writes deny the same property under a new client')
  rejected(context() + `perform ${saveScope(floatingShift, guard, [siteA, siteB], 1)};`, 'PT409')
  sql(`update public.sites set client_id='${clientB}',active=false where id='${siteB}';`)
  check(serviceScopes(guard, [floatingShift]), floatingRow(floatingShift, guard, []), 'An inactive approved property leaves a blocked marker')
  sql(`update public.sites set active=true where id='${siteB}';`)
  check(save(floatingShift, guard, [], 1).revision, 2, 'Revocation appends a separate generation')
  check(serviceScopes(guard, [floatingShift]), floatingRow(floatingShift, guard, []), 'Revocation leaves an explicit blocked marker')
  check(authorizeScope(floatingShift, guard, siteB), 'f', 'Revoked scope cannot authorize new reports')
  check(sql("select count(*) from private.audit_events where table_name='floating_patrol_scope_approvals'"), '2', 'Only accepted changes retain audit receipts')
  rejected(`update private.floating_patrol_scope_approvals set reason='Cannot overwrite history';`, '42501')
  rejected('delete from private.floating_patrol_scope_properties;', '42501')
  check(save(floatingShift, guard, [siteB], 2).revision, 3, 'A reviewed approval can deliberately supersede the revocation')

  const floatingDraft = materialize(), successor = newShiftFor(floatingDraft, floatingShift)
  publish(floatingDraft)
  check(serviceScopes(guard, [floatingShift]), floatingRow(floatingShift, guard, []), 'Superseded assignment loses its prior scope')
  check(getScope(successor).status, 'review_required', 'Operations can identify a replacement requiring explicit review')
  check(serviceScopes(guard, [successor]), floatingRow(successor, guard, []), 'Even an unchanged copied block waits for explicit review and cannot use fixed fallback')
  check(save(successor, guard, [siteB], null).revision, 1, 'Operations may explicitly approve the new published assignment')
  check(authorizeScope(successor, guard, siteB), 't', 'Only the new approved exact occurrence authorizes the property')
  check(authorizeScope(floatingShift, guard, siteB), 'f', 'Preserved historical records do not grant current report writes')
  sql(`update public.shift_assignments set assigned_at=assigned_at+interval '1 second' where shift_id='${successor}' and employee_id='${guard}';`)
  check(serviceScopes(guard, [successor]), floatingRow(successor, guard, []), 'Reassigning even the same guard and row UUID invalidates the old assignment snapshot')
  check(save(successor, guard, [siteB], 1).revision, 2, 'Operations can reapprove the exact re-assignment')
  check(save(successor, guard, [], 2).revision, 3, 'Operations can remove the floating properties before attaching a native route')
  check(Boolean(sql(context() + `select public.link_patrol_route_shift('${routeA}','${successor}','${guard}');`)), true, 'Fixed-route setup succeeds after explicit revocation')
  check(serviceScopes(guard, [successor]), [], 'An explicitly connected native route now has precedence and no floating fallback')
}
