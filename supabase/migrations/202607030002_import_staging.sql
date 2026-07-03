begin;

alter table private.source_sheets
  add column source_range text,
  add column start_row integer,
  add column start_column integer;

alter table private.source_cells
  add column row_number integer,
  add column column_number integer,
  add column value_type text;

alter table private.source_cells
  add constraint source_cells_coordinates_positive
  check (
    (row_number is null and column_number is null)
    or (row_number > 0 and column_number > 0)
  );

create index source_cells_coordinates_idx
  on private.source_cells(source_sheet_id, row_number, column_number);

create table private.import_evidence_files (
  id uuid primary key default gen_random_uuid(),
  import_run_id uuid not null references private.import_runs(id) on delete restrict,
  evidence_kind text not null,
  filename text not null,
  sha256 text not null,
  record_count bigint,
  created_at timestamptz not null default now(),
  constraint import_evidence_kind_present check (btrim(evidence_kind) <> ''),
  constraint import_evidence_filename_present check (btrim(filename) <> ''),
  constraint import_evidence_sha256_format check (sha256 ~ '^[a-f0-9]{64}$'),
  constraint import_evidence_record_count_nonnegative check (record_count is null or record_count >= 0),
  constraint import_evidence_kind_unique unique (import_run_id, evidence_kind)
);

create table private.source_sheet_metadata (
  source_sheet_id uuid primary key references private.source_sheets(id) on delete restrict,
  workbook_sheet_id text,
  state text not null default 'visible',
  part_name text,
  dimension text,
  merged_ranges jsonb not null default '[]'::jsonb,
  row_metadata jsonb not null default '[]'::jsonb,
  column_metadata jsonb not null default '[]'::jsonb,
  pane jsonb,
  auto_filter text,
  conditional_formatting_count integer not null default 0,
  data_validation_count integer not null default 0,
  constraint source_sheet_metadata_counts_nonnegative check (
    conditional_formatting_count >= 0 and data_validation_count >= 0
  )
);

create table private.source_cell_metadata (
  source_cell_id bigint primary key references private.source_cells(id) on delete restrict,
  raw_cell_type text,
  style_index integer,
  font_id integer,
  bold boolean not null default false,
  fill_id integer,
  border_id integer,
  number_format_id integer,
  raw_value text,
  resolved_text text,
  formula_attributes jsonb,
  hyperlink jsonb,
  constraint source_cell_metadata_ids_nonnegative check (
    coalesce(style_index, 0) >= 0
    and coalesce(font_id, 0) >= 0
    and coalesce(fill_id, 0) >= 0
    and coalesce(border_id, 0) >= 0
    and coalesce(number_format_id, 0) >= 0
  )
);

create table private.source_annotations (
  id bigint generated always as identity primary key,
  source_sheet_id uuid not null references private.source_sheets(id) on delete restrict,
  kind text not null check (kind in ('comment', 'hyperlink')),
  cell_reference text,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table private.source_relationships (
  id bigint generated always as identity primary key,
  source_sheet_id uuid not null references private.source_sheets(id) on delete restrict,
  relationship_id text not null,
  relationship_type text not null,
  target_mode text not null,
  target text not null,
  created_at timestamptz not null default now(),
  constraint source_relationships_unique unique (source_sheet_id, relationship_id)
);

create table private.import_candidates (
  id uuid primary key default gen_random_uuid(),
  import_run_id uuid not null references private.import_runs(id) on delete restrict,
  kind text not null check (kind in ('weekly_schedule', 'employee', 'site', 'shift')),
  candidate_key text not null,
  confidence text not null check (confidence in ('review', 'blocking_review')),
  review_status text not null default 'pending'
    check (review_status in ('pending', 'accepted', 'rejected', 'superseded')),
  payload jsonb not null,
  source_references jsonb not null default '[]'::jsonb,
  fingerprint text not null,
  reviewed_by uuid references public.employees(id) on delete restrict,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint import_candidates_key_present check (btrim(candidate_key) <> ''),
  constraint import_candidates_fingerprint_format check (fingerprint ~ '^[a-f0-9]{64}$'),
  constraint import_candidates_review_complete check (
    (review_status = 'pending' and reviewed_by is null and reviewed_at is null)
    or (review_status <> 'pending' and reviewed_by is not null and reviewed_at is not null)
  ),
  constraint import_candidates_unique unique (import_run_id, kind, candidate_key)
);

create index import_candidates_review_idx
  on private.import_candidates(import_run_id, review_status, confidence);

alter table private.import_issues
  add column candidate_id uuid references private.import_candidates(id) on delete restrict,
  add column source_reference jsonb,
  add column related_sources jsonb not null default '[]'::jsonb;

create table private.import_review_decisions (
  id bigint generated always as identity primary key,
  import_run_id uuid not null references private.import_runs(id) on delete restrict,
  candidate_id uuid references private.import_candidates(id) on delete restrict,
  issue_id uuid references private.import_issues(id) on delete restrict,
  decision text not null,
  note text not null,
  decided_by uuid not null references public.employees(id) on delete restrict,
  decided_at timestamptz not null default clock_timestamp(),
  previous_record jsonb,
  resulting_record jsonb,
  constraint import_review_decisions_target check (num_nonnulls(candidate_id, issue_id) = 1),
  constraint import_review_decisions_note_present check (btrim(note) <> '')
);

create trigger import_candidates_set_updated_at
before update on private.import_candidates
for each row execute function private.set_updated_at();

create trigger import_review_decisions_append_only
before update or delete on private.import_review_decisions
for each row execute function private.prevent_append_only_change();

create trigger source_cell_metadata_append_only
before update or delete on private.source_cell_metadata
for each row execute function private.prevent_append_only_change();

create trigger source_sheet_metadata_append_only
before update or delete on private.source_sheet_metadata
for each row execute function private.prevent_append_only_change();

create function private.import_run_is_promotable(target_import_run_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.import_runs run
    where run.id = target_import_run_id
      and run.status = 'reconciled'
      and run.reconciliation_digest is not null
      and run.blocking_issue_count = 0
      and not exists (
        select 1
        from private.import_issues issue
        where issue.import_run_id = run.id
          and issue.severity = 'blocking'
          and issue.resolved_at is null
      )
      and not exists (
        select 1
        from private.import_candidates candidate
        where candidate.import_run_id = run.id
          and candidate.review_status = 'pending'
      )
  )
$$;

create function private.protect_import_promotion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'promoted' and old.status <> 'promoted' then
    if not private.import_run_is_promotable(old.id) then
      raise exception 'The import is not eligible for promotion.';
    end if;
  end if;
  return new;
end
$$;

create trigger import_runs_protect_promotion
before update of status on private.import_runs
for each row execute function private.protect_import_promotion();

create function public.register_source_import(
  source_record jsonb,
  evidence_records jsonb,
  extractor_version text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_file_id uuid;
  import_run_id uuid;
  evidence_record jsonb;
begin
  if source_record ->> 'sha256' !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid source fingerprint.';
  end if;
  if coalesce((source_record ->> 'byteSize')::bigint, 0) <= 0 then
    raise exception 'Invalid source byte size.';
  end if;
  if jsonb_typeof(evidence_records) <> 'array' then
    raise exception 'Evidence records must be an array.';
  end if;

  select source.id into source_file_id
  from private.source_files source
  where source.sha256 = source_record ->> 'sha256';

  if source_file_id is null then
    insert into private.source_files (
      original_filename,
      sha256,
      byte_size,
      storage_path
    ) values (
      source_record ->> 'filename',
      source_record ->> 'sha256',
      (source_record ->> 'byteSize')::bigint,
      source_record ->> 'storagePath'
    )
    returning id into source_file_id;
  end if;

  insert into private.import_runs (source_file_id, status, extractor_version)
  values (source_file_id, 'registered', extractor_version)
  returning id into import_run_id;

  for evidence_record in select value from jsonb_array_elements(evidence_records)
  loop
    insert into private.import_evidence_files (
      import_run_id,
      evidence_kind,
      filename,
      sha256,
      record_count
    ) values (
      import_run_id,
      evidence_record ->> 'kind',
      evidence_record ->> 'filename',
      evidence_record ->> 'sha256',
      nullif(evidence_record ->> 'recordCount', '')::bigint
    );
  end loop;

  return import_run_id;
end
$$;

create function public.ingest_source_sheets(target_import_run_id uuid, records jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  item jsonb;
  inserted_count integer := 0;
  row_count integer;
  column_count integer;
  start_row integer;
  start_column integer;
begin
  if jsonb_typeof(records) <> 'array' then
    raise exception 'Sheet records must be an array.';
  end if;

  for item in select value from jsonb_array_elements(records)
  loop
    row_count := (item ->> 'rowCount')::integer;
    column_count := (item ->> 'columnCount')::integer;
    start_row := nullif(item ->> 'startRow', '')::integer;
    start_column := nullif(item ->> 'startColumn', '')::integer;

    insert into private.source_sheets (
      import_run_id,
      sheet_index,
      name,
      hidden,
      max_row,
      max_column,
      source_range,
      start_row,
      start_column
    ) values (
      target_import_run_id,
      (item ->> 'index')::integer,
      item ->> 'name',
      false,
      case when row_count = 0 then 0 else start_row + row_count - 1 end,
      case when column_count = 0 then 0 else start_column + column_count - 1 end,
      item ->> 'address',
      start_row,
      start_column
    );
    inserted_count := inserted_count + 1;
  end loop;

  update private.import_runs
  set status = 'extracting', started_at = coalesce(started_at, clock_timestamp())
  where id = target_import_run_id and status in ('registered', 'extracting');

  return inserted_count;
end
$$;

create function public.ingest_source_cells(target_import_run_id uuid, records jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  item jsonb;
  source_sheet_id uuid;
  inserted_count integer := 0;
begin
  if jsonb_typeof(records) <> 'array' then
    raise exception 'Cell records must be an array.';
  end if;

  for item in select value from jsonb_array_elements(records)
  loop
    select sheet.id into source_sheet_id
    from private.source_sheets sheet
    where sheet.import_run_id = target_import_run_id
      and sheet.sheet_index = (item ->> 'sheetIndex')::integer;

    if source_sheet_id is null then
      raise exception 'Cell record references an unknown worksheet index.';
    end if;

    insert into private.source_cells (
      source_sheet_id,
      cell_address,
      raw_value,
      formula,
      row_number,
      column_number,
      value_type
    ) values (
      source_sheet_id,
      item ->> 'address',
      jsonb_build_object('type', item ->> 'valueType', 'value', item -> 'value'),
      item ->> 'formula',
      (item ->> 'row')::integer,
      (item ->> 'column')::integer,
      item ->> 'valueType'
    );
    inserted_count := inserted_count + 1;
  end loop;

  return inserted_count;
end
$$;

create function public.ingest_ooxml_sheet_metadata(target_import_run_id uuid, records jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  item jsonb;
  source_sheet_id uuid;
  inserted_count integer := 0;
begin
  for item in select value from jsonb_array_elements(records)
  loop
    select sheet.id into source_sheet_id
    from private.source_sheets sheet
    where sheet.import_run_id = target_import_run_id
      and sheet.sheet_index = (item ->> 'index')::integer;

    update private.source_sheets
    set hidden = coalesce(item ->> 'state', 'visible') <> 'visible'
    where id = source_sheet_id;

    insert into private.source_sheet_metadata (
      source_sheet_id,
      workbook_sheet_id,
      state,
      part_name,
      dimension,
      merged_ranges,
      row_metadata,
      column_metadata,
      pane,
      auto_filter,
      conditional_formatting_count,
      data_validation_count
    ) values (
      source_sheet_id,
      item ->> 'sheetId',
      coalesce(item ->> 'state', 'visible'),
      item ->> 'part',
      item ->> 'dimension',
      coalesce(item -> 'mergedRanges', '[]'::jsonb),
      coalesce(item -> 'rowMetadata', '[]'::jsonb),
      coalesce(item -> 'columnMetadata', '[]'::jsonb),
      item -> 'pane',
      item ->> 'autoFilter',
      coalesce((item ->> 'conditionalFormattingCount')::integer, 0),
      coalesce((item ->> 'dataValidationCount')::integer, 0)
    );
    inserted_count := inserted_count + 1;
  end loop;
  return inserted_count;
end
$$;

create function public.ingest_ooxml_cell_metadata(target_import_run_id uuid, records jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  item jsonb;
  source_cell_id bigint;
  inserted_count integer := 0;
begin
  for item in select value from jsonb_array_elements(records)
  loop
    select cell.id into source_cell_id
    from private.source_sheets sheet
    join private.source_cells cell on cell.source_sheet_id = sheet.id
    where sheet.import_run_id = target_import_run_id
      and sheet.sheet_index = (item ->> 'sheetIndex')::integer
      and cell.cell_address = item ->> 'address';

    if source_cell_id is null then
      raise exception 'OOXML metadata references an unknown source cell.';
    end if;

    insert into private.source_cell_metadata (
      source_cell_id,
      raw_cell_type,
      style_index,
      font_id,
      bold,
      fill_id,
      border_id,
      number_format_id,
      raw_value,
      resolved_text,
      formula_attributes,
      hyperlink
    ) values (
      source_cell_id,
      item ->> 'cellType',
      nullif(item ->> 'styleIndex', '')::integer,
      nullif(item ->> 'fontId', '')::integer,
      coalesce((item ->> 'bold')::boolean, false),
      nullif(item ->> 'fillId', '')::integer,
      nullif(item ->> 'borderId', '')::integer,
      nullif(item ->> 'numberFormatId', '')::integer,
      item ->> 'rawValue',
      item ->> 'resolvedText',
      item -> 'formulaAttributes',
      item -> 'hyperlink'
    );
    inserted_count := inserted_count + 1;
  end loop;
  return inserted_count;
end
$$;

create function public.ingest_source_annotations(target_import_run_id uuid, records jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  item jsonb;
  source_sheet_id uuid;
  inserted_count integer := 0;
begin
  for item in select value from jsonb_array_elements(records)
  loop
    select sheet.id into source_sheet_id
    from private.source_sheets sheet
    where sheet.import_run_id = target_import_run_id
      and sheet.sheet_index = (item ->> 'sheetIndex')::integer;

    if source_sheet_id is null then
      raise exception 'Annotation references an unknown worksheet.';
    end if;

    insert into private.source_annotations (
      source_sheet_id,
      kind,
      cell_reference,
      payload
    ) values (
      source_sheet_id,
      item ->> 'kind',
      item ->> 'reference',
      item
    );
    inserted_count := inserted_count + 1;
  end loop;
  return inserted_count;
end
$$;

create function public.ingest_source_relationships(target_import_run_id uuid, records jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  item jsonb;
  source_sheet_id uuid;
  inserted_count integer := 0;
begin
  for item in select value from jsonb_array_elements(records)
  loop
    select sheet.id into source_sheet_id
    from private.source_sheets sheet
    where sheet.import_run_id = target_import_run_id
      and sheet.sheet_index = (item ->> 'sheetIndex')::integer;

    if source_sheet_id is null then
      raise exception 'Relationship references an unknown worksheet.';
    end if;

    insert into private.source_relationships (
      source_sheet_id,
      relationship_id,
      relationship_type,
      target_mode,
      target
    ) values (
      source_sheet_id,
      item ->> 'id',
      item ->> 'type',
      item ->> 'targetMode',
      item ->> 'target'
    );
    inserted_count := inserted_count + 1;
  end loop;
  return inserted_count;
end
$$;

create function public.ingest_import_candidates(target_import_run_id uuid, records jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  item jsonb;
  inserted_count integer := 0;
begin
  for item in select value from jsonb_array_elements(records)
  loop
    insert into private.import_candidates (
      import_run_id,
      kind,
      candidate_key,
      confidence,
      payload,
      source_references,
      fingerprint
    ) values (
      target_import_run_id,
      item ->> 'kind',
      item ->> 'candidateKey',
      item ->> 'confidence',
      item -> 'payload',
      coalesce(item -> 'sourceReferences', '[]'::jsonb),
      item ->> 'fingerprint'
    );
    inserted_count := inserted_count + 1;
  end loop;
  return inserted_count;
end
$$;

create function public.ingest_import_issues(target_import_run_id uuid, records jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  item jsonb;
  source_cell_id bigint;
  inserted_count integer := 0;
begin
  for item in select value from jsonb_array_elements(records)
  loop
    source_cell_id := null;
    if item -> 'source' is not null and item -> 'source' <> 'null'::jsonb then
      select cell.id into source_cell_id
      from private.source_sheets sheet
      join private.source_cells cell on cell.source_sheet_id = sheet.id
      where sheet.import_run_id = target_import_run_id
        and sheet.sheet_index = (item -> 'source' ->> 'sheetIndex')::integer
        and cell.cell_address = item -> 'source' ->> 'address';
    end if;

    insert into private.import_issues (
      import_run_id,
      source_cell_id,
      severity,
      code,
      message,
      source_reference,
      related_sources
    ) values (
      target_import_run_id,
      source_cell_id,
      (item ->> 'severity')::public.issue_severity,
      item ->> 'code',
      item ->> 'message',
      item -> 'source',
      coalesce(item -> 'relatedSources', '[]'::jsonb)
    );
    inserted_count := inserted_count + 1;
  end loop;
  return inserted_count;
end
$$;

create function public.finalize_source_import(
  target_import_run_id uuid,
  expected_sheet_count integer,
  expected_cell_count bigint,
  expected_candidate_count bigint,
  reconciliation_sha256 text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  actual_sheet_count bigint;
  actual_cell_count bigint;
  actual_candidate_count bigint;
  actual_blocking_count integer;
  actual_warning_count integer;
begin
  if reconciliation_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid reconciliation fingerprint.';
  end if;

  select count(*) into actual_sheet_count
  from private.source_sheets where source_sheets.import_run_id = target_import_run_id;

  select count(*) into actual_cell_count
  from private.source_cells cell
  join private.source_sheets sheet on sheet.id = cell.source_sheet_id
  where sheet.import_run_id = target_import_run_id;

  select count(*) into actual_candidate_count
  from private.import_candidates where import_candidates.import_run_id = target_import_run_id;

  if actual_sheet_count <> expected_sheet_count
    or actual_cell_count <> expected_cell_count
    or actual_candidate_count <> expected_candidate_count
  then
    raise exception 'Imported record counts do not match the verified evidence manifest.';
  end if;

  select
    count(*) filter (where severity = 'blocking' and resolved_at is null),
    count(*) filter (where severity = 'warning' and resolved_at is null)
  into actual_blocking_count, actual_warning_count
  from private.import_issues
  where import_issues.import_run_id = target_import_run_id;

  update private.import_runs
  set
    status = 'review',
    completed_at = clock_timestamp(),
    source_cell_count = actual_cell_count,
    normalized_record_count = actual_candidate_count,
    blocking_issue_count = actual_blocking_count,
    warning_count = actual_warning_count,
    reconciliation_digest = reconciliation_sha256
  where id = target_import_run_id and status = 'extracting';

  if not found then
    raise exception 'Import run is not in the extracting state.';
  end if;

  return true;
end
$$;

revoke all on private.import_evidence_files,
  private.source_sheet_metadata,
  private.source_cell_metadata,
  private.source_annotations,
  private.source_relationships,
  private.import_candidates,
  private.import_review_decisions
from public, anon, authenticated;

grant all on private.import_evidence_files,
  private.source_sheet_metadata,
  private.source_cell_metadata,
  private.source_annotations,
  private.source_relationships,
  private.import_candidates,
  private.import_review_decisions
to service_role;

grant usage, select on all sequences in schema private to service_role;

revoke all on function public.register_source_import(jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.ingest_source_sheets(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ingest_source_cells(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ingest_ooxml_sheet_metadata(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ingest_ooxml_cell_metadata(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ingest_source_annotations(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ingest_source_relationships(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ingest_import_candidates(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ingest_import_issues(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.finalize_source_import(uuid, integer, bigint, bigint, text) from public, anon, authenticated;

grant execute on function public.register_source_import(jsonb, jsonb, text) to service_role;
grant execute on function public.ingest_source_sheets(uuid, jsonb) to service_role;
grant execute on function public.ingest_source_cells(uuid, jsonb) to service_role;
grant execute on function public.ingest_ooxml_sheet_metadata(uuid, jsonb) to service_role;
grant execute on function public.ingest_ooxml_cell_metadata(uuid, jsonb) to service_role;
grant execute on function public.ingest_source_annotations(uuid, jsonb) to service_role;
grant execute on function public.ingest_source_relationships(uuid, jsonb) to service_role;
grant execute on function public.ingest_import_candidates(uuid, jsonb) to service_role;
grant execute on function public.ingest_import_issues(uuid, jsonb) to service_role;
grant execute on function public.finalize_source_import(uuid, integer, bigint, bigint, text) to service_role;

commit;
