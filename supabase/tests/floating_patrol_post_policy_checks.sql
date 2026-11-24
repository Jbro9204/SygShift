create function pg_temp.save_post(target_revision integer, variadic site_numbers integer[]) returns jsonb language sql as $$
  select public.save_floating_patrol_post_scope_v1(pg_temp.fx(30),
    array(select pg_temp.fx(n) from unnest(site_numbers) n), target_revision, 'Approved confirmed dispatch destinations')$$;
create function pg_temp.scope(guard_number integer, shift_number integer) returns jsonb language sql as $$
  select to_jsonb(s) from private.floating_patrol_scope_state_v1(pg_temp.fx(guard_number), pg_temp.fx(shift_number)) s$$;
create function pg_temp.props(variadic site_numbers integer[]) returns jsonb language sql as $$
  select to_jsonb(array(select pg_temp.fx(n) from unnest(site_numbers) n))$$;
select set_config('fixture.actor',pg_temp.fx(2)::text,true); set local fixture.mfa='yes'; set local fixture.role='authenticated';
insert into results values
  ('guard-cannot-write-post-policy',pg_temp.expect_failure('42501',$test$select pg_temp.save_post(null,21,22)$test$)),
  ('guard-cannot-read-post-policy',pg_temp.expect_failure('42501',$test$select public.get_floating_patrol_post_scope_v1(pg_temp.fx(30))$test$)),
  ('guard-cannot-use-service-catalog-reader',pg_temp.expect_failure('42501',$test$select public.service_get_floating_patrol_scopes_v1(pg_temp.fx(2),array[pg_temp.fx(50)])$test$));
select set_config('fixture.actor',pg_temp.fx(4)::text,true);
insert into results values ('assignment-only-manager-cannot-approve-recurring-post',pg_temp.expect_failure('42501',$test$select pg_temp.save_post(null,21,22)$test$));
select set_config('fixture.actor',pg_temp.fx(1)::text,true); set local fixture.mfa='no';
insert into results values ('route-manager-mfa-remains-required',pg_temp.expect_failure('42501',$test$select pg_temp.save_post(null,21,22)$test$));
set local fixture.mfa='yes';
insert into results values
  ('migration-is-dark-until-approval',pg_temp.scope(2,50)->>'status'='not_configured'),
  ('no-original-empty-policy',pg_temp.expect_failure('22023',$test$select pg_temp.save_post(null,variadic array[]::int[])$test$)),
  ('inactive-client-property-rejected',pg_temp.expect_failure('22023',$test$select pg_temp.save_post(null,24)$test$)),
  ('duplicate-site-rejected',pg_temp.expect_failure('22023',$test$select pg_temp.save_post(null,21,21)$test$));
insert into results values ('scoped-two-client-save-verified',(pg_temp.save_post(null,21,22)->>'active')::boolean);
insert into results values
  ('stale-writer-disallowed',pg_temp.expect_failure('PT409',$test$select pg_temp.save_post(null,23)$test$)),
  ('inherited-list-uses-active-shift-not-exact-override',pg_temp.scope(2,50)->'site_ids'=pg_temp.props(21,22)
    and pg_temp.scope(2,50)->'approved_site_ids'='[]'::jsonb and pg_temp.scope(2,50)->'revision'='null'::jsonb),
  ('recurring-post-inherits-without-another-save',pg_temp.scope(2,51)->'site_ids'=pg_temp.props(21,22)),
  ('unassigned-employee-denied',pg_temp.scope(3,50)->>'status'='ineligible'),
  ('other-assigned-employee-uses-own-shift',pg_temp.scope(3,52)->'site_ids'=pg_temp.props(21,22)),
  ('superseded-shift-denied',pg_temp.scope(2,57)->>'status'='ineligible'),
  ('unconfigured-post-remains-fixed',pg_temp.scope(2,53)->>'status'='not_configured'),
  ('policy-does-not-open-already-ended-shift',pg_temp.scope(2,54)->>'status'='ended' and pg_temp.scope(2,54)->'site_ids'='[]'::jsonb),
  ('native-route-precedence',pg_temp.scope(2,55)->>'status'='native_route' and pg_temp.scope(2,55)->'site_ids'='[]'::jsonb);
set local fixture.role='service_role';
insert into results values
  ('picker-uses-canonical-inherited-sites',public.service_get_floating_patrol_scopes_v1(pg_temp.fx(2),array[pg_temp.fx(50)]) #> '{0,site_ids}'=pg_temp.props(21,22)),
  ('picker-omits-unassigned-officer',public.service_get_floating_patrol_scopes_v1(pg_temp.fx(3),array[pg_temp.fx(50)])='[]'::jsonb),
  ('report-writer-uses-inherited-scope',private.floating_patrol_site_authorized_v1(pg_temp.fx(2),pg_temp.fx(50),pg_temp.fx(21))
    and private.floating_patrol_site_authorized_v1(pg_temp.fx(2),pg_temp.fx(50),pg_temp.fx(22))
    and not private.floating_patrol_site_authorized_v1(pg_temp.fx(2),pg_temp.fx(50),pg_temp.fx(20))
    and not private.floating_patrol_site_authorized_v1(pg_temp.fx(3),pg_temp.fx(50),pg_temp.fx(21))),
  ('report-write-acquires-shared-advisory-fences',exists(select 1 from pg_locks where pid=pg_backend_pid() and locktype='advisory' and mode='ShareLock'));
set local fixture.role='authenticated';
select public.save_floating_patrol_scope_v1(pg_temp.fx(50),pg_temp.fx(2),array[pg_temp.fx(23)],null,'Explicit shift-only destination');
select public.save_floating_patrol_scope_v1(pg_temp.fx(51),pg_temp.fx(2),'{}'::uuid[],null,'Do not use recurring list on this shift');
insert into results values
  ('explicit-approval-wins',pg_temp.scope(2,50)->'revision'='1'::jsonb and pg_temp.scope(2,50)->'site_ids'=pg_temp.props(23)),
  ('per-shift-block-prevents-inherited-fallback',pg_temp.scope(2,51)->>'status'='blocked' and pg_temp.scope(2,51)->'revision'='1'::jsonb and pg_temp.scope(2,51)->'site_ids'='[]'::jsonb);
-- End a synthetic occurrence just after revision 1 but before revision 2.
update public.shifts set ends_at=(select approved_at+interval '0.000001 seconds' from private.floating_patrol_post_policies where post_id=pg_temp.fx(30) and revision=1)
  where id=pg_temp.fx(56);
select pg_temp.save_post(1,21,22,23);
insert into results values
  ('later-additions-do-not-expand-ended-shift',pg_temp.scope(2,56)->'site_ids'=pg_temp.props(21,22)),
  ('active-shift-sees-current-approved-policy',pg_temp.scope(3,52)->'site_ids'=pg_temp.props(21,22,23));
update public.sites set client_id=pg_temp.fx(10) where id=pg_temp.fx(22);
insert into results values
  ('client-relinked-property-drops-immediately',pg_temp.scope(3,52)->'site_ids'=pg_temp.props(21,23)),
  ('cannot-silently-reapprove-changed-client',pg_temp.expect_failure('PT409',$test$select pg_temp.save_post(2,21,22,23)$test$));
update public.sites set client_id=pg_temp.fx(11) where id=pg_temp.fx(22);
update public.clients set status='paused' where id=pg_temp.fx(11);
insert into results values ('inactive-client-property-drops-immediately',pg_temp.scope(3,52)->'site_ids'=pg_temp.props(21,23));
update public.clients set status='active' where id=pg_temp.fx(11);
insert into results values ('unrevoked-same-client-reactivation-restores-existing-approval',pg_temp.scope(3,52)->'site_ids'=pg_temp.props(21,22,23));
update public.sites set active=false where id=pg_temp.fx(20);
insert into results values ('inactive-anchor-blocks-entire-inherited-list',pg_temp.scope(3,52)->>'status'='blocked' and pg_temp.scope(3,52)->'site_ids'='[]'::jsonb);
update public.sites set active=true where id=pg_temp.fx(20);
select pg_temp.save_post(2,21,23);
select pg_temp.save_post(3,21,22,23);
insert into results values ('removal-and-readd-does-not-revive-old-scope',pg_temp.scope(2,56)->'site_ids'=pg_temp.props(21));
select pg_temp.save_post(4,variadic array[]::int[]);
insert into results values
  ('revocation-denies-inherited-fallback',pg_temp.scope(3,52)->>'status'='blocked' and pg_temp.scope(3,52)->'site_ids'='[]'::jsonb),
  ('revocation-preserves-explicit-override',pg_temp.scope(2,50)->'site_ids'=pg_temp.props(23)),
  ('post-audit-and-revisions-retained',(select count(*)=5 and count(*) filter(where operation='revoke')=1 from private.audit_events where table_name='floating_patrol_post_policies')),
  ('append-only-revisions-protected',pg_temp.expect_failure('42501',$test$update private.floating_patrol_post_policies set reason='Changed immutable approval'$test$));
set local fixture.role='service_role';
insert into results values
  ('blocked-scope-returned-as-explicit-empty-binding',public.service_get_floating_patrol_scopes_v1(pg_temp.fx(3),array[pg_temp.fx(52)]) #> '{0,site_ids}'='[]'::jsonb),
  ('both-private-tables-forced-rls', (select count(*)=2 from pg_class where oid in
   ('private.floating_patrol_post_policies'::regclass,'private.floating_patrol_post_policy_properties'::regclass) and relrowsecurity and relforcerowsecurity)),
  ('browser-and-service-cannot-read-private-tables',not exists (
   select 1 from unnest(array['anon','authenticated','service_role']) r where
   has_table_privilege(r,'private.floating_patrol_post_policies','select,insert,update,delete')
   or has_table_privilege(r,'private.floating_patrol_post_policy_properties','select,insert,update,delete'))),
  ('grant-only-authenticated-with-db-gate',
   has_function_privilege('authenticated','public.save_floating_patrol_post_scope_v1(uuid,uuid[],integer,text)','execute')
   and not has_function_privilege('anon','public.save_floating_patrol_post_scope_v1(uuid,uuid[],integer,text)','execute')
   and not has_function_privilege('service_role','public.save_floating_patrol_post_scope_v1(uuid,uuid[],integer,text)','execute')),
  ('unchanged-published-schedule-clock-payroll-and-native-records',(select state from protected_before)=(select state from protected_state));
select jsonb_build_object('checks',count(*),'passed',coalesce(bool_and(passed is true),false),
  'failed',coalesce(jsonb_agg(name) filter(where passed is distinct from true),'[]'::jsonb)) from results;
