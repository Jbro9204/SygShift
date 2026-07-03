begin;

alter table private.source_cells
  add column evidence_origin text not null default 'artifact'
    check (evidence_origin in ('artifact', 'ooxml_only'));

create function private.a1_column_number(cell_address text)
returns integer
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  letters text := substring(cell_address from '^([A-Z]+)');
  result integer := 0;
  position integer;
begin
  if letters is null then
    raise check_violation using message = 'Invalid A1 cell address.';
  end if;
  for position in 1..char_length(letters)
  loop
    result := result * 26 + ascii(substring(letters from position for 1)) - ascii('A') + 1;
  end loop;
  return result;
end
$$;

create or replace function public.ingest_ooxml_cell_metadata(target_import_run_id uuid, records jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  item jsonb;
  source_sheet_id uuid;
  source_cell_id bigint;
  inserted_count integer := 0;
  target_cell_address text;
begin
  if jsonb_typeof(records) <> 'array' then
    raise exception 'OOXML cell metadata records must be an array.';
  end if;

  for item in select value from jsonb_array_elements(records)
  loop
    target_cell_address := item ->> 'address';
    select sheet.id, cell.id into source_sheet_id, source_cell_id
    from private.source_sheets sheet
    left join private.source_cells cell
      on cell.source_sheet_id = sheet.id and cell.cell_address = target_cell_address
    where sheet.import_run_id = target_import_run_id
      and sheet.sheet_index = (item ->> 'sheetIndex')::integer;

    if source_sheet_id is null then
      raise exception 'OOXML metadata references an unknown worksheet.';
    end if;

    if source_cell_id is null then
      insert into private.source_cells (
        source_sheet_id,
        cell_address,
        raw_value,
        displayed_value,
        formula,
        row_number,
        column_number,
        value_type,
        evidence_origin
      ) values (
        source_sheet_id,
        target_cell_address,
        jsonb_build_object('type', 'blank', 'value', null),
        item ->> 'resolvedText',
        item ->> 'formula',
        substring(target_cell_address from '([0-9]+)$')::integer,
        private.a1_column_number(target_cell_address),
        'blank',
        'ooxml_only'
      )
      returning id into source_cell_id;
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

revoke all on all functions in schema private from public, anon, authenticated;
grant execute on all functions in schema private to service_role;

commit;
