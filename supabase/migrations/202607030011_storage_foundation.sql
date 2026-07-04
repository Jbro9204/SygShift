begin;

do $$
begin
  if to_regclass('storage.buckets') is null then
    return;
  end if;

  insert into storage.buckets (
    id,
    name,
    public,
    file_size_limit,
    allowed_mime_types
  ) values
    (
      'employee-photos',
      'employee-photos',
      false,
      10485760,
      array['image/png', 'image/jpeg', 'image/webp']
    ),
    (
      'credential-documents',
      'credential-documents',
      false,
      26214400,
      array['application/pdf', 'image/png', 'image/jpeg', 'image/webp']
    ),
    (
      'source-imports',
      'source-imports',
      false,
      52428800,
      array[
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel',
        'text/csv'
      ]
    ),
    (
      'payroll-exports',
      'payroll-exports',
      false,
      26214400,
      array[
        'application/pdf',
        'text/csv',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      ]
    )
  on conflict (id) do update
  set
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types,
    updated_at = now();
end
$$;

do $$
begin
  if to_regclass('storage.objects') is null then
    return;
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'sygshift_employee_photos_privileged_read'
  ) then
    create policy sygshift_employee_photos_privileged_read
    on storage.objects
    for select
    to authenticated
    using (
      bucket_id = 'employee-photos'
      and public.is_supervisor_or_admin()
      and public.has_mfa()
    );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'sygshift_employee_photos_privileged_write'
  ) then
    create policy sygshift_employee_photos_privileged_write
    on storage.objects
    for all
    to authenticated
    using (
      bucket_id = 'employee-photos'
      and public.is_supervisor_or_admin()
      and public.has_mfa()
    )
    with check (
      bucket_id = 'employee-photos'
      and public.is_supervisor_or_admin()
      and public.has_mfa()
    );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'sygshift_credential_documents_privileged_access'
  ) then
    create policy sygshift_credential_documents_privileged_access
    on storage.objects
    for all
    to authenticated
    using (
      bucket_id = 'credential-documents'
      and public.is_supervisor_or_admin()
      and public.has_mfa()
    )
    with check (
      bucket_id = 'credential-documents'
      and public.is_supervisor_or_admin()
      and public.has_mfa()
    );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'sygshift_source_imports_admin_access'
  ) then
    create policy sygshift_source_imports_admin_access
    on storage.objects
    for all
    to authenticated
    using (
      bucket_id = 'source-imports'
      and public.is_admin()
      and public.has_mfa()
    )
    with check (
      bucket_id = 'source-imports'
      and public.is_admin()
      and public.has_mfa()
    );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'sygshift_payroll_exports_admin_access'
  ) then
    create policy sygshift_payroll_exports_admin_access
    on storage.objects
    for all
    to authenticated
    using (
      bucket_id = 'payroll-exports'
      and public.is_admin()
      and public.has_mfa()
    )
    with check (
      bucket_id = 'payroll-exports'
      and public.is_admin()
      and public.has_mfa()
    );
  end if;
end
$$;

commit;
