import assert from 'node:assert/strict'

export function runAdminPasswordSetRegression({sql, scalar, failSql, claims, role, A, G, AU, GU, AS, OLD, NEW, scenarios, crossAppProjectionTested = true}) {
  const id = digit => `60000000-0000-4000-8000-${String(digit).padStart(12, '0')}`
  const body = (key, required = true) => `jsonb_build_object('actorEmployeeId','${A}','actorAuthSessionId','${AS}',
    'recentMfaAt',clock_timestamp(),'mfaMethod','authenticator','employeeId','${G}','confirmationUsername','guard',
    'reason','Synthetic administrator password setup','idempotencyKey','${id(key)}','requestHash',repeat('${String(key).at(-1)}',64),
    'requireChangeAtNextLogin',${required})`
  const begin = payload => JSON.parse(scalar(`${role('service_role')}select public.service_begin_employee_password_set(${payload});`))
  const finish = (payload, key, outcome = 'confirmed', authId = GU) => JSON.parse(scalar(`${role('service_role')}
    select public.service_finish_employee_password_set(${payload}||jsonb_build_object('operationId','${id(key)}','outcome','${outcome}','providerAuthUserId','${authId}'));`))
  const context = (session = NEW) => scalar(`${claims(GU, session)}select (public.get_password_change_requirement()->>'mustChangePassword')::boolean;`)
  const providerWrite = (operation, password) => `begin;update auth.users set encrypted_password='${password}' where id='${GU}';
    update auth.users set raw_app_meta_data=raw_app_meta_data||jsonb_build_object('sygshift_password_set_operation_id','${id(operation)}') where id='${GU}';commit;`
  sql('update private.password_change_feature_config set enabled=false;')
  assert.match(failSql(`${role('authenticated')}select public.service_begin_employee_password_set(${body(1)});`), /privilege|denied/)
  assert.match(failSql(`${role('service_role')}select public.service_begin_employee_password_set(${body(1)}||jsonb_build_object('recentMfaAt',now()-interval '1 hour'));`), /fresh verification/)
  assert.match(failSql(`${role('service_role')}select public.service_begin_employee_password_set(${body(1)}||jsonb_build_object('confirmationUsername','otherguard'));`), /confirmation is unavailable/)
  assert.match(failSql(`${role('service_role')}select public.service_begin_employee_password_set(${body(1)}||jsonb_build_object('password','DO-NOT-PERSIST'));`), /Credentials must never enter/)
  assert.equal(scalar('select count(*) from private.admin_password_set_operations;'), '0')
  scenarios.push('Admin password setting requires exact target, current Admin/MFA and service boundary; raw secrets rejected from SQL')

  const first = begin(body(1))
  assert.equal(first.providerWriteAllowed, true)
  assert.equal(first.expiresAt, null)
  assert.equal(begin(body(1)).providerWriteAllowed, false)
  assert.equal(scalar('select count(*) from private.admin_password_set_operations;'), '1')
  assert.equal(context(OLD), 'f')
  assert.equal(scalar(`select (private.password_change_session_requirement('${GU}',null)->>'kind');`), 'admin_set')
  assert.equal(scalar(`select (private.password_change_session_requirement('${GU}','30000000-0000-4000-8000-000000000099')->>'ready')::boolean;`), 'f')
  sql(`update auth.sessions set created_at=clock_timestamp() where id='${NEW}';`)
  assert.equal(context(), 't')
  assert.equal(scalar(`${claims(GU, NEW)}select cardinality(public.get_effective_permissions());`), '0')
  if (crossAppProjectionTested) {
    assert.equal(scalar(`${claims(GU, NEW)}select (public.get_session_context_emergency()->>'must_change_password')::boolean;`), 't')
  }
  assert.match(failSql(`${claims(GU, NEW)}select public.mark_password_changed_verified();`), /not yet confirmed/)
  assert.match(failSql(`${role('service_role')}select public.service_begin_employee_password_set(${body(2)});`), /earlier password update/)
  scenarios.push('chosen password has no expiry; first request claims provider once; next-login gate preserves old sessions and blocks unfinished setup')

  sql(`update auth.users set encrypted_password='synthetic-unrelated-self-change' where id='${GU}';`)
  assert.equal(scalar(`${role('service_role')}select public.service_get_employee_password_set(${body(1)})->>'providerUpdateVerified';`), 'false')
  assert.match(failSql(`${role('service_role')}select public.service_finish_employee_password_set(${body(1)}||jsonb_build_object('operationId','${id(1)}','outcome','confirmed','providerAuthUserId','${GU}'));`), /exact employee/)
  assert.match(failSql(`update auth.users set raw_app_meta_data=jsonb_build_object('sygshift_password_set_operation_id','${id(1)}') where id='${GU}';`), /same provider transaction/)
  assert.match(failSql(`begin;update auth.users set encrypted_password='synthetic-double-transition-one' where id='${GU}';
    update auth.users set encrypted_password='synthetic-double-transition-two' where id='${GU}';
    update auth.users set raw_app_meta_data=jsonb_build_object('sygshift_password_set_operation_id','${id(1)}') where id='${GU}';commit;`), /same provider transaction/)
  assert.equal(scalar(`select encrypted_password from auth.users where id='${GU}';`), 'synthetic-unrelated-self-change')
  sql(providerWrite(1, 'synthetic-chosen-admin-password-one'))
  assert.match(failSql(`${claims(GU, NEW)}select public.mark_password_changed_verified();`), /not yet confirmed/)
  assert.match(failSql(`${role('service_role')}select public.service_finish_employee_password_set(${body(1)}||jsonb_build_object('operationId','${id(1)}','outcome','confirmed','providerAuthUserId','${AU}'));`), /exact employee/)
  assert.equal(scalar(`${role('service_role')}select public.service_get_employee_password_set(${body(1)})->>'providerUpdateVerified';`), 'true')
  assert.match(failSql(`${role('service_role')}select public.service_finish_employee_password_set(${body(1)}||jsonb_build_object('operationId','${id(1)}','outcome','confirmed','providerAuthUserId','${GU}','recentMfaAt',now()-interval '1 hour'));`), /fresh verification/)
  const otherAdmin = '10000000-0000-4000-8000-000000000004'
  const otherAuth = '20000000-0000-4000-8000-000000000004'
  const otherSession = '30000000-0000-4000-8000-000000000004'
  sql(`insert into auth.users(id,encrypted_password) values('${otherAuth}','synthetic-second-admin');
    insert into public.employees(id,username,status,role) values('${otherAdmin}','otheradmin','active','admin');
    insert into private.employee_accounts(employee_id,auth_user_id,must_change_password,created_at,updated_at)
      values('${otherAdmin}','${otherAuth}',false,now(),now());
    insert into auth.sessions values('${otherSession}','${otherAuth}',now(),null);
    insert into private.test_employee_permissions values('${otherAdmin}','admin.users.password_reset');`)
  assert.equal(finish(`${body(1)}||jsonb_build_object('actorEmployeeId','${otherAdmin}','actorAuthSessionId','${otherSession}')`, 1).status, 'confirmed')
  assert.equal(scalar(`select raw_app_meta_data ? 'sygshift_password_set_operation_id' from auth.users where id='${GU}';`), 'f')
  assert.equal(scalar(`select count(*) from private.admin_password_set_provider_receipts where operation_id='${id(1)}';`), '1')
  assert.equal(finish(body(1), 1).providerWriteAllowed, false)
  assert.match(failSql(`${claims(GU, NEW)}select public.mark_password_changed_verified();`), /No completed credential change/)
  assert.equal(context(), 't')
  sql(`update auth.users set encrypted_password='synthetic-employee-selected-password-one' where id='${GU}';`)
  sql(`${claims(GU, NEW)}select public.mark_password_changed_verified();`)
  assert.equal(context(), 'f')
  assert.match(failSql(providerWrite(1, 'synthetic-chosen-admin-password-one')), /no longer open|cannot be replayed/)
  assert.equal(scalar(`select encrypted_password from auth.users where id='${GU}';`), 'synthetic-employee-selected-password-one')
  sql(`update auth.users set raw_app_meta_data=raw_app_meta_data||'{"ordinary_setting":"preserved"}'::jsonb where id='${GU}';`)
  assert.equal(scalar(`select status from private.admin_set_password_requirements where id='${id(1)}';`), 'completed')
  scenarios.push('Admin-assigned credential cannot satisfy its own change requirement; real later employee change unlocks both app contexts')
  sql(`begin;update auth.users set encrypted_password='synthetic-later-ordinary-recovery' where id='${GU}';
    update auth.users set raw_app_meta_data=raw_app_meta_data||'{"ordinary_recovery":"successful"}'::jsonb where id='${GU}';commit;`)
  assert.equal(scalar(`select encrypted_password from auth.users where id='${GU}';`), 'synthetic-later-ordinary-recovery')
  assert.equal(scalar(`select raw_app_meta_data->>'ordinary_setting' from auth.users where id='${GU}';`), 'preserved')
  assert.equal(scalar(`select raw_app_meta_data->>'ordinary_recovery' from auth.users where id='${GU}';`), 'successful')
  assert.match(failSql(providerWrite(1, 'synthetic-replay-after-ordinary-recovery')), /no longer open|cannot be replayed/)
  assert.equal(scalar(`select encrypted_password from auth.users where id='${GU}';`), 'synthetic-later-ordinary-recovery')
  scenarios.push('terminal marker removed without losing receipt; future ordinary password and metadata recovery works while old assignment replay fails')

  begin(body(2))
  assert.equal(finish(body(2), 2, 'known_failed').status, 'known_failed')
  assert.equal(context(), 'f')
  assert.equal(scalar(`select status from private.admin_set_password_requirements where id='${id(2)}';`), 'canceled')
  scenarios.push('known provider rejection cancels only its staged requirement and preserves existing account')

  begin(body(3))
  sql(providerWrite(3, 'synthetic-assigned-three'))
  finish(body(3), 3)
  sql(`update auth.sessions set created_at=clock_timestamp() where id='${NEW}';update private.employee_accounts set must_change_password=true where employee_id='${G}';`)
  assert.equal(context(), 't')
  begin(body(4, false))
  assert.equal(context(), 't')
  sql(providerWrite(4, 'synthetic-no-forced-change'))
  const unchecked = finish(body(4, false), 4)
  assert.equal(unchecked.requireChangeAtNextLogin, false)
  assert.equal(unchecked.expiresAt, null)
  assert.equal(context(), 'f')
  assert.equal(scalar(`select must_change_password from private.employee_accounts where employee_id='${G}';`), 'f')
  assert.equal(scalar(`select status from private.admin_set_password_requirements where id='${id(3)}';`), 'canceled')
  scenarios.push('unchecked change requirement clears only target flags after verified password setting, not at prepare time')

  sql(`update private.employee_accounts set disabled_at=now() where employee_id='${G}';
    update auth.users set banned_until=now()+interval '1 year' where id='${GU}';
    insert into private.emergency_access_authority values('${G}','suspended');`)
  const disabledBefore = scalar(`select jsonb_build_object('disabled',a.disabled_at,'banned',u.banned_until,'role',e.role,'authority',ea.access_state)::text
    from private.employee_accounts a join auth.users u on u.id=a.auth_user_id join public.employees e on e.id=a.employee_id
    join private.emergency_access_authority ea on ea.employee_id=e.id where e.id='${G}';`)
  begin(body(5, false))
  sql(providerWrite(5, 'synthetic-disabled-password'))
  finish(body(5, false), 5)
  assert.equal(scalar(`select jsonb_build_object('disabled',a.disabled_at,'banned',u.banned_until,'role',e.role,'authority',ea.access_state)::text
    from private.employee_accounts a join auth.users u on u.id=a.auth_user_id join public.employees e on e.id=a.employee_id
    join private.emergency_access_authority ea on ea.employee_id=e.id where e.id='${G}';`), disabledBefore)
  assert.match(failSql(`${claims(GU, NEW)}select public.mark_password_changed_verified();`), /active employee/)
  sql(`update private.employee_accounts set disabled_at=null where employee_id='${G}';
    update auth.users set banned_until=null where id='${GU}';delete from private.emergency_access_authority where employee_id='${G}';`)
  scenarios.push('setting credentials never unbans, reinstates, changes roles or clears an independent suspension')

  begin(body(6))
  assert.equal(finish(body(6), 6, 'unknown').status, 'uncertain')
  assert.equal(begin(body(6)).providerWriteAllowed, false)
  assert.match(failSql(`${role('service_role')}select public.service_begin_employee_password_set(${body(7)});`), /earlier password update/)
  sql(`update auth.sessions set created_at=clock_timestamp() where id='${NEW}';`)
  assert.match(failSql(`${claims(GU, NEW)}select public.mark_password_changed_verified();`), /not yet confirmed/)
  assert.match(failSql(`${role('service_role')}select public.service_cancel_employee_password_set(${body(6)}||jsonb_build_object('operationId','${id(6)}','recentMfaAt',now()-interval '1 hour'));`), /fresh verification/)
  assert.equal(JSON.parse(scalar(`${role('service_role')}select public.service_cancel_employee_password_set(${body(6)}||jsonb_build_object('operationId','${id(6)}'));`)).status, 'canceled')
  assert.match(failSql(providerWrite(6, 'synthetic-late-canceled-provider')), /no longer open/)
  assert.equal(context(), 'f')
  scenarios.push('unknown provider outcome is retained without automatic retry or false completion')

  assert.equal(scalar(`select count(*) from information_schema.columns where table_schema='private'
    and table_name in('admin_password_set_operations','admin_set_password_requirements','admin_password_set_events')
    and column_name in('password','password_hash','password_digest','temporary_password','new_password');`), '0')
  assert.equal(scalar(`select role from public.employees where id='${G}';`), 'guard')
  assert.equal(scalar('select count(*) from auth.sessions;'), '4')
  assert.match(failSql(`update private.admin_password_set_events set event_type='uncertain';`), /immutable/)
  const result = JSON.parse(scalar(`${role('service_role')}select public.service_get_employee_password_set(${body(6)});`))
  assert.equal(result.status, 'canceled')
  scenarios.push('audit metadata contains no credentials, preserves history and existing sessions, with protected readback')

  begin(body(7))
  sql(providerWrite(7, 'synthetic-admin-seven'))
  sql(`update auth.users set encrypted_password='synthetic-unrelated-after-seven' where id='${GU}';`)
  const superseded = finish(body(7), 7)
  assert.equal(superseded.status, 'known_failed')
  assert.equal(superseded.errorCode, 'password_changed_after_assignment')
  assert.equal(scalar(`select status from private.admin_set_password_requirements where id='${id(7)}';`), 'canceled')
  scenarios.push('a concurrent later password change cannot be reported as the Admin-assigned password still being current')
}

export function installAdminPasswordBoundaryFixture({sql}, migration) {
  sql(`create role authenticator; create schema storage;create schema realtime;
    create table storage.objects(id integer);create table realtime.messages(id integer);
    insert into storage.objects values(1);insert into realtime.messages values(1);
    alter table storage.objects enable row level security;alter table realtime.messages enable row level security;
    create policy baseline on storage.objects for all to authenticated using(true) with check(true);
    create policy baseline on realtime.messages for all to authenticated using(true) with check(true);
    grant usage on schema storage,realtime to authenticated;grant select on storage.objects,realtime.messages to authenticated;
    alter table public.employees add column employee_number text,add column first_name text,add column last_name text,
      add column preferred_name text,add column employment_type text,add column job_title text,add column time_zone text;
    create function public.sygilant_emergency_access_allowed() returns boolean language sql stable security definer set search_path='' as $$
      select not exists(select 1 from private.employee_accounts a left join private.emergency_access_authority e on e.employee_id=a.employee_id
        where a.auth_user_id=auth.uid() and (a.disabled_at is not null or coalesce(e.access_state,'active')<>'active'))$$;
    create function public.sygilant_emergency_access_pre_request() returns void language plpgsql stable security definer set search_path='' as $$
begin
  if (select auth.uid()) is not null
     and not public.sygilant_emergency_access_allowed() then
    raise insufficient_privilege using message =
      'Employee access is suspended by the centralized access authority.';
  end if;
end;
$$;
    alter role authenticator set pgrst.db_pre_request='public.sygilant_emergency_access_pre_request';`)
  sql(migration)
}

export function runAdminPasswordBoundaryRegression({sql, scalar, failSql, claims, role, A, G, AU, GU, AS, OLD, NEW, scenarios}) {
  const operationId = '70000000-0000-4000-8000-000000000001'
  const request = `jsonb_build_object('actorEmployeeId','${A}','actorAuthSessionId','${AS}',
    'recentMfaAt',clock_timestamp(),'mfaMethod','authenticator','employeeId','${G}','confirmationUsername','guard',
    'reason','Synthetic cross-platform boundary verification','idempotencyKey','${operationId}','requestHash',repeat('a',64),
    'requireChangeAtNextLogin',true)`
  sql(`${role('service_role')}select public.service_begin_employee_password_set(${request});
    update auth.sessions set created_at=clock_timestamp() where id='${NEW}';`)
  const path = (value, method = 'POST') => `select set_config('request.path','${value}',false);select set_config('request.method','${method}',false);`
  assert.match(failSql(`${role('authenticated')}${claims(GU, NEW)}${path('/employee_availability','GET')}select public.sygilant_emergency_access_pre_request();`), /Choose your own password/)
  sql(`${role('authenticated')}${claims(GU, OLD)}${path('/employee_availability','GET')}select public.sygilant_emergency_access_pre_request();`)
  assert.equal(scalar(`${role('authenticated')}${claims(GU, NEW)}${path('/rpc/get_password_change_identity')}select public.sygilant_emergency_access_pre_request();select public.get_password_change_identity()->>'id';`), G)
  assert.match(failSql(`${role('authenticated')}${claims(GU, NEW)}${path('/rpc/get_password_change_identity/extra')}select public.sygilant_emergency_access_pre_request();`), /Choose your own password/)
  assert.equal(scalar(`${role('authenticated')}${claims(GU, NEW)}set role authenticated;select count(*) from storage.objects;reset role;`), '0')
  assert.equal(scalar(`${role('authenticated')}${claims(GU, NEW)}set role authenticated;select count(*) from realtime.messages;reset role;`), '0')
  assert.equal(scalar(`${role('authenticated')}${claims(AU, AS)}set role authenticated;select count(*) from storage.objects;reset role;`), '1')
  sql(`begin;update auth.users set encrypted_password='synthetic-boundary-admin-assigned' where id='${GU}';
    -- Model the provider's password-reset session revocation, then a fresh
    -- sign-in. The migration itself never restores a removed session.
    delete from auth.sessions where user_id='${GU}';
    update auth.users set raw_app_meta_data=jsonb_build_object('sygshift_password_set_operation_id','${operationId}') where id='${GU}';commit;
    insert into auth.sessions values('${NEW}','${GU}',clock_timestamp(),null);
    ${role('service_role')}select public.service_finish_employee_password_set(${request}||jsonb_build_object('operationId','${operationId}','outcome','confirmed','providerAuthUserId','${GU}'));`)
  assert.match(failSql(`${role('authenticated')}${claims(GU, NEW)}${path('/rpc/mark_password_changed_verified')}select public.sygilant_emergency_access_pre_request();select public.mark_password_changed_verified();`), /No completed credential change/)
  sql(`update auth.users set encrypted_password='synthetic-boundary-employee-final' where id='${GU}';
    ${role('authenticated')}${claims(GU, NEW)}${path('/rpc/mark_password_changed_verified')}select public.sygilant_emergency_access_pre_request();select public.mark_password_changed_verified();`)
  sql(`${role('authenticated')}${claims(GU, NEW)}${path('/employee_availability','GET')}select public.sygilant_emergency_access_pre_request();`)
  assert.equal(scalar(`${role('authenticated')}${claims(GU, NEW)}set role authenticated;select count(*) from storage.objects;reset role;`), '1')
  assert.equal(scalar(`${claims(GU, NEW)}select set_config('test.has_mfa','false',false);select public.get_effective_permissions()::text;`), '{apps.sygilant.access,apps.sygshift.access,time.punch}')
  sql('alter table auth.sessions rename to sessions_unavailable;')
  assert.equal(scalar(`select private.password_change_session_requirement('${GU}','${NEW}')::text;`), '{}')
  sql('alter table auth.sessions_unavailable rename to sessions;')
  scenarios.push('actual cross-app Data API, Storage and Realtime boundary blocks enrolled sessions and restores access after verified personal password change')
  scenarios.push('ordinary Guard MFA remains unchanged and no-enrollment helper works without the Auth session table')
}

export async function runAdminPasswordCancellationRaces({sql, asyncSql, scalar, role, A, G, GU, AS, NEW, scenarios}) {
  const id = digit => `90000000-0000-4000-8000-${String(digit).padStart(12, '0')}`
  const body = key => `jsonb_build_object('actorEmployeeId','${A}','actorAuthSessionId','${AS}','recentMfaAt',clock_timestamp(),
    'mfaMethod','authenticator','employeeId','${G}','confirmationUsername','guard','reason','Synthetic cancellation race verification',
    'idempotencyKey','${id(key)}','requestHash',repeat('a',64),'requireChangeAtNextLogin',true,'operationId','${id(key)}')`
  const waitForSleep = async name => {
    for (let attempt = 0; attempt < 30; attempt++) {
      if (scalar(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event='PgSleep';`) === '1') return
      await new Promise(done => setTimeout(done, 50))
    }
    throw new Error(`The synthetic concurrency barrier did not start: ${name}`)
  }
  sql(`${role('service_role')}select public.service_begin_employee_password_set(${body(1)});`)
  const providerFirst = asyncSql(`select set_config('application_name','password-provider-first',false);begin;
    update auth.users set encrypted_password='synthetic-provider-first' where id='${GU}';
    delete from auth.sessions where user_id='${GU}';
    update auth.users set raw_app_meta_data=jsonb_build_object('sygshift_password_set_operation_id','${id(1)}') where id='${GU}';
    select pg_sleep(2);commit;`)
  await waitForSleep('password-provider-first')
  const cancelAfter = asyncSql(`${role('service_role')}select public.service_cancel_employee_password_set(${body(1)});`)
  const [providerResult, cancelResult] = await Promise.all([providerFirst, cancelAfter])
  assert.equal(providerResult.status, 0, providerResult.stderr)
  assert.notEqual(cancelResult.status, 0)
  assert.match(cancelResult.stderr, /provider saved/)
  sql(`${role('service_role')}select public.service_finish_employee_password_set(${body(1)}||jsonb_build_object('outcome','confirmed','providerAuthUserId','${GU}'));
    insert into auth.sessions values('${NEW}','${GU}',clock_timestamp(),null);`)
  scenarios.push('native concurrent provider-first password write defeats cancellation and requires confirmed result')

  sql(`${role('service_role')}select public.service_begin_employee_password_set(${body(2)});`)
  const before = scalar(`select encrypted_password from auth.users where id='${GU}';`)
  const sessionsBefore = scalar(`select count(*) from auth.sessions where user_id='${GU}';`)
  const receiptsBefore = scalar(`select count(*) from private.password_change_receipts where auth_user_id='${GU}';`)
  const cancelFirst = asyncSql(`select set_config('application_name','password-cancel-first',false);begin;
    ${role('service_role')}select public.service_cancel_employee_password_set(${body(2)});select pg_sleep(2);commit;`)
  await waitForSleep('password-cancel-first')
  const providerAfter = asyncSql(`begin;update auth.users set encrypted_password='synthetic-late-provider' where id='${GU}';
    delete from auth.sessions where user_id='${GU}';
    update auth.users set raw_app_meta_data=jsonb_build_object('sygshift_password_set_operation_id','${id(2)}') where id='${GU}';commit;`)
  const [cancelFirstResult, providerAfterResult] = await Promise.all([cancelFirst, providerAfter])
  assert.equal(cancelFirstResult.status, 0, cancelFirstResult.stderr)
  assert.notEqual(providerAfterResult.status, 0)
  assert.match(providerAfterResult.stderr, /no longer open/)
  assert.equal(scalar(`select encrypted_password from auth.users where id='${GU}';`), before)
  assert.equal(scalar(`select count(*) from auth.sessions where user_id='${GU}';`), sessionsBefore)
  assert.equal(scalar(`select count(*) from private.password_change_receipts where auth_user_id='${GU}';`), receiptsBefore)
  assert.equal(scalar(`select count(*) from private.admin_password_set_provider_receipts where operation_id='${id(2)}';`), '0')
  assert.equal(scalar(`select status from private.admin_password_set_operations where id='${id(2)}';`), 'canceled')
  scenarios.push('native concurrent cancellation-first fences and rolls back late provider password and session changes')
}
