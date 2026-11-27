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

  sql(read('supabase/migrations/20261124151311_floating_patrol_post_policy.sql'))
  const continuity = read('supabase/migrations/20261127211000_floating_patrol_schedule_continuity.sql')
  const beforeContinuity = protectedSnapshot()
  const predecessor = 'private.floating_patrol_predecessor_exists_v1(uuid,uuid)'
  const preservePublication = 'private.preserve_floating_patrol_schedule_publication_v1()'
  const postId = sql(`select post_id from public.shifts where id='${floatingShift}';`)
  check(JSON.parse(sql(context() + `select public.save_floating_patrol_post_scope_v1('${postId}',${uuidArray([siteA])},null,'Approved recurring test properties');`)).active, true, 'Recurring policy is available as a control')
  check(save(floatingShift, otherGuard, [], null).status, 'blocked', 'Second guard explicitly revokes the recurring post list')
  const beforeFix = JSON.parse(sql(context() + `begin;
    create temporary table unpatched_floating_draft as
      select private.materialize_schedule_draft_revision((select week_starts_on from public.schedules
        where id=(select schedule_id from public.shifts where id='${floatingShift}'))) as id;
    do $publish$ begin perform public.publish_schedule_draft((select id from unpatched_floating_draft)); end $publish$;
    select public.get_floating_patrol_scope_v1(link.draft_shift_id,'${guard}')
    from private.schedule_shift_revision_links link join unpatched_floating_draft draft on draft.id=link.draft_schedule_id
    where link.source_shift_id='${floatingShift}';
    rollback;`))
  check(beforeFix.status, 'review_required', 'Before the fix, the unchanged published shift loses its exact approval')
  check(beforeFix.siteIds, [], 'Before the fix, the Guard cannot use the approved site on the new revision')
  check(getScope(floatingShift).siteIds, [siteB], 'The unpatched control rolls back, keeping its starting approval')
  sql(`begin;\n${migrationBody(continuity)}\nrollback;`)
  check(sql(`select to_regprocedure('${preservePublication}') is null`), 't', 'Publication continuity migration can be rehearsed and rolled back')
  sql(continuity)
  check(protectedSnapshot(), beforeContinuity, 'Activating continuity does not modify schedules, reports, payroll, or patrol records')
  for (const role of ['anon', 'authenticated', 'service_role']) {
    check(sql(`select has_function_privilege('${role}','${preservePublication}','execute')`), 'f', 'Publication trigger is private')
    check(sql(`select has_function_privilege('${role}','${predecessor}','execute')`), 'f', 'Predecessor helper stays private')
  }

  const floatingDraft = materialize()
  let successor = newShiftFor(floatingDraft, floatingShift)
  sql(`update public.sites set client_id='${clientA}' where id='${siteB}';`)
  publish(floatingDraft)
  check(serviceScopes(guard, [floatingShift]), floatingRow(floatingShift, guard, []), 'Superseded assignment loses current write authority')
  check(getScope(successor).approvedSiteIds, [siteB], 'Unchanged copy preserves the approved property ID even when it is unavailable')
  check(getScope(successor).status, 'blocked', 'Approved property cannot be reused under a different client')
  check(getScope(successor, otherGuard).status, 'blocked', 'Empty exact approval stays revoked on full publication')
  check(getScope(successor, otherGuard).revision, 1, 'Revocation has an exact new generation ahead of reusable scope')
  check(authorizeScope(successor, guard, siteA), 'f', 'Exact continuity does not add a recurring property')
  sql(`update public.sites set client_id='${clientB}' where id='${siteB}';`)
  check(serviceScopes(guard, [successor]), floatingRow(successor, guard, [siteB]), 'Original client binding is effective after the original relationship is restored')
  check(authorizeScope(successor, guard, siteB), 't', 'Unchanged full publication preserves exact report authorization')
  check(authorizeScope(floatingShift, guard, siteB), 'f', 'Retained predecessor does not authorize a new report')

  const findSuccessor = (previous, employee, targetSchedule = null) => sql(`select target.id from public.shifts target
    join public.schedules schedule on schedule.id=target.schedule_id
      and ${targetSchedule ? `schedule.id='${targetSchedule}'` : "schedule.status='published'"}
    join public.shift_assignments assignment on assignment.shift_id=target.id and assignment.employee_id='${employee}'
    join public.shifts source on source.id='${previous}'
    where target.post_id=source.post_id and target.starts_at=source.starts_at and target.ends_at=source.ends_at;`)
  for (const employee of [otherGuard, guard, guard]) {
    const scopedDraft = materialize()
    sql(context() + `select public.publish_employee_schedule_slice('${scopedDraft}','${employee}');`)
    const prior = successor
    successor = findSuccessor(prior, guard)
    const revokedSuccessor = findSuccessor(prior, otherGuard)
    check(getScope(successor).siteIds, [siteB], 'Employee-only publication preserves unchanged exact approval')
    check(getScope(revokedSuccessor, otherGuard).status, 'blocked', 'Employee-only publication preserves explicit revocation')
    check(getScope(revokedSuccessor, otherGuard).revision, 1, 'Revocation is copied as history and continues to override recurring scope')
    check(authorizeScope(prior, guard, siteB), 'f', 'Only the current published successor authorizes a new report')
  }

  const coverageBefore = protectedSnapshot(), draftBeforeCoverage = materialize()
  const pendingBlock = findSuccessor(successor, guard, draftBeforeCoverage)
  sql(`update public.shifts set notes='Synthetic unpublished edit' where id='${pendingBlock}';`)
  const coverageSource = successor
  const dispatchPublish = `private.create_absence_coverage_shift('${coverageSource}','${actor}')`
  const opening = sql(context() + `select ${dispatchPublish};`)
  const coverageRelease = sql(`select schedule_id from public.shifts where id='${opening}';`)
  successor = findSuccessor(coverageSource, guard, coverageRelease)
  check(getScope(successor).siteIds, [siteB], 'The existing Dispatch publisher keeps the unchanged exact approval')
  check(authorizeScope(successor, guard, siteB), 't', 'Sygilant report authority follows the unchanged assignment through Dispatch publication')
  check(authorizeScope(successor, guard, siteA), 'f', 'Dispatch publication does not add the recurring property')
  check(authorizeScope(coverageSource, guard, siteB), 'f', 'Dispatch supersedes the former assignment without reusing it for new reports')
  check(getScope(findSuccessor(coverageSource, otherGuard, coverageRelease), otherGuard).status, 'blocked', 'Dispatch publication preserves the explicit revocation of another assigned guard')
  check(sql(`select count(*) from private.floating_patrol_scope_approvals where shift_id='${opening}';`), '0', 'The separate vacancy does not inherit an approval')
  check(authorizeScope(opening, guard, siteB), 'f', 'The separate vacancy cannot authorize a report for the original guard')
  check(authorizeScope(opening, otherGuard, siteB), 'f', 'The separate vacancy cannot authorize a report for another guard')
  check(sql(`select count(*) from public.shifts s join public.schedules w on w.id=s.schedule_id
    where w.status='draft' and w.previous_revision_id='${coverageRelease}' and s.notes='Synthetic unpublished edit';`),
  '1', 'Dispatch rebases one copy of existing unpublished work')
  rejected(context() + `perform ${dispatchPublish};`, '23514')
  check(sql(`select count(*) from public.shifts s join public.schedules w on w.id=s.schedule_id
    where w.status='published' and s.coverage_source_shift_id='${coverageSource}';`), '1', 'Retry does not duplicate published coverage')
  check(sql(`select count(*) from private.audit_events where operation='preserve_schedule_revision' and row_id='${successor}'
    and new_record->>'employeeId'='${guard}';`), '1', 'Retry does not duplicate the carried approval receipt')
  check(protectedSnapshot(), coverageBefore, 'Dispatch publication preserves original coverage, punches, payroll, reports and evidence')

  const changedDraft = materialize()
  const changedBlock = findSuccessor(successor, guard, changedDraft)
  sql(`update public.shift_assignments set assigned_at=assigned_at+interval '1 second'
    where shift_id='${changedBlock}' and employee_id='${guard}';`)
  sql(context() + `select public.publish_employee_schedule_slice('${changedDraft}','${guard}');`)
  successor = findSuccessor(successor, guard)
  check(getScope(successor).status, 'review_required', 'Reassigning the same employee requires a new approval')
  check(serviceScopes(guard, [successor]), floatingRow(successor, guard, []), 'Changed assignment stays blocked ahead of recurring scope')
  check(save(successor, guard, [siteB], null).revision, 1, 'Operations can approve the changed assignment explicitly')
  sql(`update public.shift_assignments set assigned_at=assigned_at+interval '1 second' where shift_id='${successor}' and employee_id='${guard}';`)
  check(serviceScopes(guard, [successor]), floatingRow(successor, guard, []), 'Reassigning even the same guard and row UUID invalidates the old assignment snapshot')
  check(save(successor, guard, [siteB], 1).revision, 2, 'Operations can reapprove the exact re-assignment')
  check(save(successor, guard, [], 2).revision, 3, 'Operations can remove the floating properties before attaching a native route')
  check(Boolean(sql(context() + `select public.link_patrol_route_shift('${routeA}','${successor}','${guard}');`)), true, 'Fixed-route setup succeeds after explicit revocation')
  check(serviceScopes(guard, [successor]), [], 'An explicitly connected native route now has precedence and no floating fallback')
  // Use a new draft directly based on this published native route.
  sql("update public.schedules set status='archived' where status='draft';")
  const nativeDraft = materialize(), nativeSuccessor = newShiftFor(nativeDraft, successor)
  publish(nativeDraft)
  check(getScope(nativeSuccessor).status, 'native_route', 'Native continuity takes precedence during actual publication')
  check(sql(`select count(*) from private.floating_patrol_scope_approvals where shift_id='${nativeSuccessor}' and employee_id='${guard}';`),
    '0', 'Publication does not copy a revocation onto an already governed native route')
}
