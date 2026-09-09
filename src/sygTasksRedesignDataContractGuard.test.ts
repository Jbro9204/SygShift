/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(join(
  process.cwd(),
  'supabase',
  'migrations',
  '20260910100000_sygtasks_redesign_data_contract.sql',
), 'utf8')

const compact = migration.toLowerCase().replace(/\s+/g, ' ')

describe('SygTasks redesign data contract', () => {
  it('is additive and keeps the private domain inaccessible to browser roles', () => {
    expect(migration).not.toMatch(/create table /i)
    expect(migration).not.toMatch(/drop (?:table|schema|function)/i)
    expect(migration).not.toMatch(/truncate /i)
    expect(migration).not.toMatch(/delete from private\.sygtasks_/i)
    expect(migration).not.toMatch(/grant .* on (?:table|schema) private\./i)
    expect(migration).not.toMatch(/create function public\.get_sygtasks_workspace/i)
    expect(migration).not.toMatch(/create function public\.mutate_sygtasks/i)
  })

  it('returns exact authorized My Work and board counts on Denver calendar boundaries', () => {
    expect(migration).toContain("statement_timestamp() at time zone 'America/Denver'")
    expect(migration).toContain("denver_today::timestamp at time zone 'America/Denver'")
    expect(migration).toContain("(denver_today + 1)::timestamp at time zone 'America/Denver'")
    expect(migration).toContain("date_trunc('month', denver_today::timestamp) at time zone 'America/Denver'")

    for (const key of [
      'accessibleBoards', 'current', 'dueToday', 'inProgress', 'upcoming', 'completedThisMonth',
    ]) {
      expect(migration).toContain(`'${key}'`)
    }
    expect(migration).toContain('private.sygtasks_is_my_work(actor_id, task.id)')
    expect(migration).toContain("task.status = 'review'")
    expect(migration).toContain("membership.member_role in ('owner', 'editor')")
    expect(migration).toContain('(select count(*) from filtered_tasks)')
    expect(migration).toContain("'total', total_count")
    const authorizedBoardsQuery = migration.match(/select coalesce\(jsonb_agg\(board_row\.payload[\s\S]*?\) board_row;/i)?.[0] ?? ''
    expect(authorizedBoardsQuery).toContain('private.sygtasks_can_view_board(actor_id, board.id)')
    expect(authorizedBoardsQuery).not.toMatch(/\blimit\s+100\b/i)
    expect(migration).toContain("'boards', board_payload")
  })

  it('searches every approved field before status, priority, and page filters', () => {
    expect(migration).toContain('position(clean_search in lower(task.title)) > 0')
    expect(migration).toContain('position(clean_search in lower(task.description)) > 0')
    expect(migration).toContain('position(clean_search in lower(board.name)) > 0')
    expect(migration).toContain('position(clean_search in lower(employee.username)) > 0')
    expect(migration).toContain('position(clean_search in lower(label.name)) > 0')
    expect(migration).toContain("clean_status not in ('backlog', 'ready', 'in_progress', 'blocked', 'review', 'done', 'canceled')")
    expect(migration).toContain("clean_priority not in ('low', 'routine', 'high', 'urgent')")
    expect(migration).toContain('offset ((page_number - 1) * page_size)')
    expect(migration).toContain('limit page_size')
    expect(migration).toContain("'status', status_count_payload")
    expect(migration).toContain("'priority', priority_count_payload")
  })

  it('atomically composes existing task and assignment authorization, audit, notification, and version behavior', () => {
    expect(migration).toContain("create_result := public.mutate_sygtasks(\n    'create_task'")
    expect(migration).toContain("assignment_result := public.mutate_sygtasks(\n      'assign_task'")
    expect(migration).toContain("clean_payload - 'assigneeId'")
    expect(migration).toContain("request_fingerprint := md5('create_task_with_assignee|' || clean_payload::text)")
    expect(migration).toContain('pg_advisory_xact_lock')
    expect(migration).toContain('private.sygtasks_action_requests')
    expect(migration).toContain("prior_request.action <> 'create_task_with_assignee'")
    expect(migration).toContain("md5(target_client_request_id::text || ':create')::uuid")
    expect(migration).toContain("md5(target_client_request_id::text || ':assign')::uuid")
    expect(migration).not.toMatch(/insert into private\.sygtasks_tasks/i)
    expect(migration).not.toMatch(/insert into private\.sygtasks_task_assignees/i)
  })

  it('pins privileged function resolution and grants only the two authenticated entry points', () => {
    expect(migration.match(/security definer/g)).toHaveLength(3)
    expect(migration.match(/set search_path = ''/g)).toHaveLength(3)
    expect(compact).toContain('revoke all on function private.sygtasks_is_my_work(uuid, uuid) from public, anon, authenticated')
    expect(compact).toContain('revoke all on function public.get_sygtasks_worklist(text, uuid, text, text, text, integer, integer, boolean) from public, anon')
    expect(compact).toContain('revoke all on function public.create_sygtasks_task(jsonb, uuid) from public, anon')
    expect(compact).toContain('grant execute on function public.get_sygtasks_worklist(text, uuid, text, text, text, integer, integer, boolean) to authenticated')
    expect(compact).toContain('grant execute on function public.create_sygtasks_task(jsonb, uuid) to authenticated')
  })
})
