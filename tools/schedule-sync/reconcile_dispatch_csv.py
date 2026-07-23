from __future__ import annotations

import csv
import json
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path


TIME_RE = re.compile(r"^\s*(\d{1,2})(\d{2})\s*-\s*(\d{1,2})(\d{2})\s*$")


@dataclass(frozen=True)
class SectionRule:
    site_name: str
    post_name: str
    requires_armed: bool
    site_code: str | None = None


SECTION_RULES: dict[int, SectionRule] = {
    13: SectionRule("PERA-Parking Lot - Unarmed", "Unarmed coverage", False, "PPL"),
    19: SectionRule("PERA-Westminster - Armed", "Armed coverage", True, "PERA-2"),
    23: SectionRule("PERA-Denver - Armed", "Armed coverage", True, "PERA"),
    33: SectionRule("Elevon-Unarmed", "Unarmed coverage", False, "ELEVON"),
    37: SectionRule("Neon Local Apt-Unarmed", "Unarmed coverage", False, "NLA"),
    41: SectionRule("3300 Tamarac Apt-Unarmed", "Unarmed coverage", False, "TAM3300"),
    45: SectionRule("4400 Syracuse Apt-Unarmed", "Unarmed coverage", False, "4SA"),
    48: SectionRule("Stone Cliff Apt-Unarmed", "Unarmed coverage", False, "STONE"),
    59: SectionRule("Cherry Tree  -  Unarmed", "Unarmed coverage", False, "CHERRY"),
    67: SectionRule("Patrol (top) -  Armed        Libraries (bottom) -  Unarmed", "Coverage - needs review", False, "PTLB"),
    73: SectionRule("Patrol-daytime PERA lunch break and day hits", "Coverage - needs review", False, "PDAY"),
    76: SectionRule("Market", "Unarmed coverage", False, "MARKET"),
    92: SectionRule("Dispatch Phone Coverage", "Coverage - needs review", False, "DPC"),
}

NAME_MAP: dict[str, str] = {
    "alex": "ahiggs",
    "angelica": "ahood",
    "anthony": "aherman",
    "bernard": "bpetermon",
    "covelle": "cpadgett",
    "daron": "djones",
    "dawson": "dkelley",
    "eddie": "ecarey",
    "elliot": "eolivarria",
    "fernando": "fgomez",
    "gaston": "gmusambay",
    "gretchen": "gschoengarth",
    "james": "jwolf",
    "jason": "jdouglass",
    "joesph": "jlee",
    "joseph": "jlee",
    "jonny": "jdurr",
    "jonny ot": "jdurr",
    "lori": "lhood",
    "matt": "mswinney",
    "mcclard": "mmcclard",
    "michelle": "mhood",
    "michael h": "mhinz",
    "randy": "rmeidinger",
    "roman": "rtimoteo",
    "ryvon": "rmattingly",
    "sidney": "sfarrell",
    "smith": "msmith",
    "steven": "sstanchick",
    "tristen": "thoneywell",
    "tyer": "tchicoine",
    "tyler": "tchicoine",
    "william": "wlane",
}

UNRESOLVED_LABELS = {"ernesto", "jade", "michael v"}
NON_EMPLOYEE_LABELS = {
    "",
    " ",
    "on patrol route",
    "patrol to cover lunch break",
    "needs training",
    "concierge",
    "day hits",
    "day patrol",
}


def clean(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip())


def normalize_name(value: str) -> str:
    cleaned = clean(value).lower()
    cleaned = cleaned.replace("(ot)", " ot")
    cleaned = re.sub(r"[^a-z0-9 ]+", " ", cleaned)
    return clean(cleaned)


def parse_time_range(value: str) -> tuple[str, str] | None:
    match = TIME_RE.match(value)
    if not match:
        return None
    start_hour, start_minute, end_hour, end_minute = (int(part) for part in match.groups())
    return f"{start_hour:02d}:{start_minute:02d}", f"{end_hour:02d}:{end_minute:02d}"


def week_dates(rows: list[list[str]]) -> list[date]:
    dates: list[date] = []
    for value in rows[0][1:8]:
        parsed = datetime.strptime(f"{value}/2026", "%m/%d/%Y").date()
        dates.append(parsed)
    return dates


def next_assignee_row(rows: list[list[str]], time_row_index: int, date_column: int) -> tuple[str, str | None]:
    primary = clean(rows[time_row_index + 1][date_column]) if time_row_index + 1 < len(rows) else ""
    secondary = clean(rows[time_row_index + 2][date_column]) if time_row_index + 2 < len(rows) else ""

    if normalize_name(primary) == "concierge" and secondary:
        return secondary, "Concierge"
    if normalize_name(primary) == "patrol to cover lunch break":
        return "", "Patrol covers lunch break"
    if normalize_name(primary) == "on patrol route":
        return "", "On patrol route"
    return primary, None


def target_rows(csv_path: Path) -> list[dict[str, object]]:
    with csv_path.open(newline="", encoding="utf-8-sig") as handle:
        rows = list(csv.reader(handle))

    dates = week_dates(rows)
    targets: list[dict[str, object]] = []

    sorted_sections = sorted(SECTION_RULES.items())
    for index, (section_row, rule) in enumerate(sorted_sections):
        section_start = section_row
        section_end = sorted_sections[index + 1][0] if index + 1 < len(sorted_sections) else len(rows) + 1

        for row_index in range(section_start, min(section_end - 1, len(rows))):
            row = rows[row_index - 1]
            for date_index, operational_date in enumerate(dates, start=1):
                if date_index >= len(row):
                    continue
                parsed_time = parse_time_range(row[date_index])
                if not parsed_time:
                    continue

                assignee_label, row_note = next_assignee_row(rows, row_index - 1, date_index)
                normalized = normalize_name(assignee_label)
                username = NAME_MAP.get(normalized)
                notes: list[str] = []
                if row_note:
                    notes.append(row_note)
                if normalized in UNRESOLVED_LABELS:
                    notes.append(f"Needs employee confirmation: {clean(assignee_label)}")
                elif normalized and normalized not in NON_EMPLOYEE_LABELS and not username:
                    notes.append(f"Needs employee confirmation: {clean(assignee_label)}")

                if normalized == "jonny ot":
                    notes.append("Overtime")

                targets.append({
                    "siteCode": rule.site_code,
                    "siteName": rule.site_name,
                    "postName": rule.post_name,
                    "requiresArmed": rule.requires_armed,
                    "localDate": operational_date.isoformat(),
                    "startTime": parsed_time[0],
                    "endTime": parsed_time[1],
                    "assigneeLabel": clean(assignee_label) or None,
                    "assigneeUsername": username,
                    "notes": "\n".join(notes) or None,
                    "isOvertime": normalized == "jonny ot",
                })

    unique: dict[tuple[object, ...], dict[str, object]] = {}
    for target in targets:
        key = (
            target["siteName"],
            target["postName"],
            target["localDate"],
            target["startTime"],
            target["endTime"],
            target["assigneeLabel"],
        )
        unique[key] = target
    return list(unique.values())


def sql_literal(value: str) -> str:
    return value.replace("'", "''")


def build_sql(targets: list[dict[str, object]]) -> str:
    payload = json.dumps(targets, indent=2)
    return f"""begin;

create temp table tmp_dispatch_schedule_targets as
select *
from jsonb_to_recordset($json${payload}$json$::jsonb) as target(
  \"siteCode\" text,
  \"siteName\" text,
  \"postName\" text,
  \"requiresArmed\" boolean,
  \"localDate\" date,
  \"startTime\" time,
  \"endTime\" time,
  \"assigneeLabel\" text,
  \"assigneeUsername\" text,
  \"notes\" text,
  \"isOvertime\" boolean
);

do $$
declare
  actor_id uuid;
  draft_schedule_id uuid;
  published_schedule_id uuid;
  target record;
  site_target record;
  target_site_id uuid;
  target_post_id uuid;
  target_shift_id uuid;
  target_employee_id uuid;
  current_employee_id uuid;
  current_employee_matches boolean;
  credential_ok boolean;
  overlap_exists boolean;
  final_notes text;
  final_is_open boolean;
  updated_count integer := 0;
  inserted_count integer := 0;
  assigned_count integer := 0;
  open_count integer := 0;
  credential_review_count integer := 0;
begin
  select employee.id into actor_id
  from public.employees employee
  where employee.username = 'jbrown';

  if actor_id is null then
    raise exception 'Cannot apply schedule correction because admin user jbrown was not found.';
  end if;

  select schedule.id into draft_schedule_id
  from public.schedules schedule
  where schedule.week_starts_on = date '2026-07-26'
    and schedule.status = 'draft'
  order by schedule.revision desc
  limit 1
  for update;

  if draft_schedule_id is null then
    raise exception 'Cannot apply schedule correction because no 07/26/2026 draft schedule exists.';
  end if;

  select schedule.id into published_schedule_id
  from public.schedules schedule
  where schedule.week_starts_on = date '2026-07-26'
    and schedule.status = 'published'
  order by schedule.revision desc
  limit 1
  for update;

  if published_schedule_id is not null then
    update public.schedules
    set status = 'superseded',
        updated_at = clock_timestamp()
    where id = published_schedule_id;
  end if;

  for site_target in
    select distinct "siteCode", "siteName", "postName", "requiresArmed"
    from tmp_dispatch_schedule_targets
  loop
    select site.id into target_site_id
    from public.sites site
    where site.name = site_target."siteName"
    order by site.created_at
    limit 1;

    if target_site_id is null then
      insert into public.sites (code, name)
      values (site_target."siteCode", site_target."siteName")
      returning id into target_site_id;
    end if;

    select post.id into target_post_id
    from public.posts post
    where post.site_id = target_site_id
      and post.name = site_target."postName"
    limit 1;

    if target_post_id is null then
      insert into public.posts (site_id, name, requires_armed)
      values (target_site_id, site_target."postName", coalesce(site_target."requiresArmed", false))
      returning id into target_post_id;
    else
      update public.posts
      set requires_armed = coalesce(site_target."requiresArmed", false),
          updated_at = clock_timestamp()
      where id = target_post_id;
    end if;
  end loop;

  delete from public.shift_assignments assignment
  using public.shifts shift
  left join public.posts post on post.id = shift.post_id
  left join public.sites site on site.id = post.site_id
  left join tmp_dispatch_schedule_targets desired
    on desired."siteName" = site.name
    and desired."postName" = post.name
    and desired."localDate" = (shift.starts_at at time zone shift.time_zone)::date
    and desired."startTime" = (shift.starts_at at time zone shift.time_zone)::time
    and desired."endTime" = (shift.ends_at at time zone shift.time_zone)::time
  where assignment.shift_id = shift.id
    and shift.schedule_id = draft_schedule_id
    and desired."siteName" is null;

  delete from public.shifts shift
  using public.posts post, public.sites site
  where shift.post_id = post.id
    and post.site_id = site.id
    and shift.schedule_id = draft_schedule_id
    and not exists (
      select 1
      from tmp_dispatch_schedule_targets desired
      where desired."siteName" = site.name
        and desired."postName" = post.name
        and desired."localDate" = (shift.starts_at at time zone shift.time_zone)::date
        and desired."startTime" = (shift.starts_at at time zone shift.time_zone)::time
        and desired."endTime" = (shift.ends_at at time zone shift.time_zone)::time
    );

  update public.shifts shift
  set notes = null,
      updated_at = clock_timestamp()
  where shift.schedule_id = draft_schedule_id
    and shift.notes ilike 'Imported schedule%';

  for target in
    select *
    from tmp_dispatch_schedule_targets
    order by \"localDate\", \"siteName\", \"startTime\", \"endTime\"
  loop
    select site.id into target_site_id
    from public.sites site
    where site.name = target.\"siteName\"
    order by site.created_at
    limit 1;

    if target_site_id is null then
      insert into public.sites (code, name)
      values (target.\"siteCode\", target.\"siteName\")
      returning id into target_site_id;
    end if;

    select post.id into target_post_id
    from public.posts post
    where post.site_id = target_site_id
      and post.name = target.\"postName\"
    limit 1;

    if target_post_id is null then
      insert into public.posts (site_id, name, requires_armed)
      values (target_site_id, target.\"postName\", coalesce(target.\"requiresArmed\", false))
      returning id into target_post_id;
    else
      update public.posts
      set requires_armed = coalesce(target.\"requiresArmed\", false),
          updated_at = clock_timestamp()
      where id = target_post_id;
    end if;

    select employee.id into target_employee_id
    from public.employees employee
    where employee.username = target.\"assigneeUsername\"
      and employee.status = 'active';

    select shift.id into target_shift_id
    from public.shifts shift
    where shift.schedule_id = draft_schedule_id
      and shift.post_id = target_post_id
      and (shift.starts_at at time zone shift.time_zone)::date = target.\"localDate\"
      and (shift.starts_at at time zone shift.time_zone)::time = target.\"startTime\"
      and (shift.ends_at at time zone shift.time_zone)::time = target.\"endTime\"
    order by shift.created_at
    limit 1;

    final_notes := nullif(btrim(coalesce(target.\"notes\", '')), '');
    final_is_open := target_employee_id is null;

    if target_shift_id is null then
      insert into public.shifts (
        schedule_id,
        post_id,
        starts_at,
        ends_at,
        time_zone,
        headcount_required,
        requires_armed,
        is_open,
        is_overtime,
        notes,
        created_by
      ) values (
        draft_schedule_id,
        target_post_id,
        (target.\"localDate\" + target.\"startTime\") at time zone 'America/Denver',
        ((target.\"localDate\" + case when target.\"endTime\" <= target.\"startTime\" then 1 else 0 end) + target.\"endTime\") at time zone 'America/Denver',
        'America/Denver',
        1,
        coalesce(target.\"requiresArmed\", false),
        final_is_open,
        coalesce(target.\"isOvertime\", false),
        final_notes,
        actor_id
      )
      returning id into target_shift_id;
      inserted_count := inserted_count + 1;
    else
      update public.shifts
      set requires_armed = coalesce(target.\"requiresArmed\", false),
          headcount_required = 1,
          is_overtime = coalesce(target.\"isOvertime\", false),
          notes = final_notes,
          updated_at = clock_timestamp()
      where id = target_shift_id;
      updated_count := updated_count + 1;
    end if;

    select assignment.employee_id into current_employee_id
    from public.shift_assignments assignment
    where assignment.shift_id = target_shift_id
      and assignment.status in ('assigned', 'confirmed', 'completed')
    order by assignment.created_at
    limit 1;

    current_employee_matches := current_employee_id is not distinct from target_employee_id;

    if target_employee_id is not null then
      credential_ok := not coalesce(target.\"requiresArmed\", false)
        or public.has_valid_credential(target_employee_id, 'armed_guard', target.\"localDate\");

      if credential_ok or current_employee_matches then
        if not current_employee_matches then
          select exists (
            select 1
            from public.shift_assignments assignment
            join public.shifts existing_shift on existing_shift.id = assignment.shift_id
            join public.schedules existing_schedule on existing_schedule.id = existing_shift.schedule_id
            where assignment.employee_id = target_employee_id
              and assignment.status in ('assigned', 'confirmed', 'completed')
              and existing_shift.id <> target_shift_id
              and existing_schedule.status in ('draft', 'published')
              and existing_shift.starts_at < (((target."localDate" + case when target."endTime" <= target."startTime" then 1 else 0 end) + target."endTime") at time zone 'America/Denver')
              and existing_shift.ends_at > ((target."localDate" + target."startTime") at time zone 'America/Denver')
          ) into overlap_exists;

          if overlap_exists then
            delete from public.shift_assignments
            where shift_id = target_shift_id
              and status in ('assigned', 'confirmed', 'completed');

            update public.shifts
            set is_open = true,
                notes = concat_ws(E'\n', final_notes, 'Needs overlap review: ' || target."assigneeLabel"),
                updated_at = clock_timestamp()
            where id = target_shift_id;
            open_count := open_count + 1;
            continue;
          end if;

          delete from public.shift_assignments
          where shift_id = target_shift_id
            and status in ('assigned', 'confirmed', 'completed');

          insert into public.shift_assignments (shift_id, employee_id, status, assigned_by)
          values (target_shift_id, target_employee_id, 'assigned', actor_id);
        end if;

        update public.shifts
        set is_open = false,
            updated_at = clock_timestamp()
        where id = target_shift_id;
        assigned_count := assigned_count + 1;
      else
        delete from public.shift_assignments
        where shift_id = target_shift_id
          and status in ('assigned', 'confirmed', 'completed');

        update public.shifts
        set is_open = true,
            notes = concat_ws(E'\\n', final_notes, 'Needs credential review: ' || target.\"assigneeLabel\"),
            updated_at = clock_timestamp()
        where id = target_shift_id;
        credential_review_count := credential_review_count + 1;
        open_count := open_count + 1;
      end if;
    else
      delete from public.shift_assignments
      where shift_id = target_shift_id
        and status in ('assigned', 'confirmed', 'completed');

      update public.shifts
      set is_open = true,
          updated_at = clock_timestamp()
      where id = target_shift_id;
      open_count := open_count + 1;
    end if;
  end loop;

  update public.schedules
  set status = 'published',
      published_at = clock_timestamp(),
      published_by = actor_id,
      updated_at = clock_timestamp()
  where id = draft_schedule_id;

  raise notice 'SygShift schedule correction complete. updated=%, inserted=%, assigned=%, open=%, credential_review=%',
    updated_count, inserted_count, assigned_count, open_count, credential_review_count;
end
$$;

commit;
"""


def main() -> None:
    csv_path = Path(r"C:\Users\Jordan\Downloads\dispatch schedule-LAPTOP-DUUH2O4N(July 26th to Aug 1st).csv")
    output_path = Path(".tmp_schedule_reconcile_20260726.sql")
    targets = target_rows(csv_path)
    output_path.write_text(build_sql(targets), encoding="utf-8")
    unresolved = sorted({
        str(target["assigneeLabel"])
        for target in targets
        if target["assigneeLabel"] and not target["assigneeUsername"]
    })
    print(json.dumps({
        "targetCount": len(targets),
        "unresolvedLabels": unresolved,
        "sqlPath": str(output_path),
    }, indent=2))


if __name__ == "__main__":
    main()
