begin;

create or replace function public.service_get_patrol_evidence_upload_target(
  target_actor_id uuid,
  target_evidence_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare evidence_record public.patrol_hit_evidence%rowtype;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  select * into evidence_record
  from public.patrol_hit_evidence
  where id = target_evidence_id and status in ('pending_upload', 'stored');
  if not found or evidence_record.uploaded_by <> target_actor_id then
    raise insufficient_privilege using message = 'This evidence upload is not available to you.';
  end if;
  return jsonb_build_object(
    'bucket', evidence_record.bucket_name,
    'evidenceId', evidence_record.id,
    'objectKey', evidence_record.object_key
  );
end
$$;

revoke all on function public.service_get_patrol_evidence_upload_target(uuid, uuid) from public, anon, authenticated;
grant execute on function public.service_get_patrol_evidence_upload_target(uuid, uuid) to service_role;

commit;
