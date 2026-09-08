/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(join(
  process.cwd(),
  'supabase',
  'migrations',
  '20260909010000_sygtasks_work_management_foundation.sql',
), 'utf8')

const compact = migration.toLowerCase().replace(/\s+/g, ' ')

const domainTables = [
  'boards',
  'board_memberships',
  'tasks',
  'task_assignees',
  'task_watchers',
  'labels',
  'task_labels',
  'checklist_items',
  'comments',
  'dependencies',
  'activity',
  'action_requests',
]

const actions = [
  'create_board', 'update_board', 'archive_board',
  'add_board_member', 'remove_board_member',
  'create_task', 'update_task', 'archive_task',
  'assign_task', 'unassign_task', 'watch_task', 'unwatch_task',
  'create_label', 'update_label', 'apply_label', 'remove_label',
  'add_checklist_item', 'update_checklist_item', 'archive_checklist_item',
  'add_comment', 'edit_comment', 'archive_comment',
  'add_dependency', 'remove_dependency',
]

describe('SygTasks private work-management contract', () => {
  it('keeps the normalized domain private and inaccessible to browser roles', () => {
    const createdTables = [...migration.matchAll(/create table private\.sygtasks_([a-z_]+)\s*\(/g)]
      .map((match) => match[1])

    expect(createdTables).toEqual(domainTables)
    expect(migration).toContain("foreach table_name in array array[")
    for (const table of domainTables) {
      expect(migration).toContain(`'sygtasks_${table}'`)
    }
    expect(migration).toContain("alter table private.%I enable row level security")
    expect(migration).toContain("alter table private.%I force row level security")
    expect(migration).toContain("revoke all on table private.%I from public, anon, authenticated")
    expect(migration).not.toMatch(/create table public\.sygtasks_/)
  })

  it('uses restrictive foreign keys, indexed relationships, and no destructive cascades', () => {
    const references = migration.match(/references (?:public|private)\.[a-z_]+\(id\)/g) ?? []
    const restrictedReferences = migration.match(/references (?:public|private)\.[a-z_]+\(id\) on delete restrict/g) ?? []

    expect(references.length).toBeGreaterThan(30)
    expect(restrictedReferences).toHaveLength(references.length)
    expect(compact).not.toContain('on delete cascade')
    expect(compact).not.toMatch(/delete from private\.sygtasks_/)

    for (const index of [
      'sygtasks_boards_owner_idx',
      'sygtasks_board_memberships_board_idx',
      'sygtasks_board_memberships_employee_idx',
      'sygtasks_tasks_board_page_idx',
      'sygtasks_task_assignees_task_idx',
      'sygtasks_task_assignees_employee_idx',
      'sygtasks_task_watchers_task_idx',
      'sygtasks_task_watchers_employee_idx',
      'sygtasks_labels_board_idx',
      'sygtasks_task_labels_task_idx',
      'sygtasks_task_labels_label_idx',
      'sygtasks_checklist_items_task_idx',
      'sygtasks_comments_task_idx',
      'sygtasks_dependencies_task_idx',
      'sygtasks_dependencies_parent_idx',
      'sygtasks_activity_board_idx',
      'sygtasks_action_requests_actor_idx',
    ]) {
      expect(migration).toContain(`create index ${index}`)
    }
  })

  it('adds effective permissions without rewriting employee access assignments', () => {
    expect(migration).toContain("'tasks.view'")
    expect(migration).toContain("'tasks.manage'")
    expect(migration).toContain('where role.system_role')
    expect(migration).toContain('and role.protected')
    expect(migration).toContain("role.code in ('system_dispatcher', 'system_scheduler', 'system_supervisor', 'system_admin')")
    expect(migration).toContain("private.sygtasks_has_permission(target_employee_id, 'tasks.manage')")
    expect(migration).not.toContain('current_app_role')
    expect(migration).not.toMatch(/employee\.role\s*=\s*'admin'/)
    expect(migration).not.toMatch(/update public\.(?:employees|employee_access_roles|employee_permission_overrides)/)
  })

  it('exposes only two active-employee, security-definer RPCs', () => {
    const publicFunctions = [...migration.matchAll(/create function public\.([a-z_]+)\s*\(/g)]
      .map((match) => match[1])

    expect(publicFunctions).toEqual(['get_sygtasks_workspace', 'mutate_sygtasks'])
    expect(migration.match(/security definer/g)?.length).toBeGreaterThanOrEqual(13)
    expect(migration.match(/set search_path = ''/g)?.length).toBeGreaterThanOrEqual(13)
    expect(migration.match(/actor_id uuid := private\.current_employee_id\(\)/g)).toHaveLength(2)
    expect(migration.match(/An active employee account is required\./g)).toHaveLength(2)
    expect(migration).toContain('revoke all on function public.get_sygtasks_workspace(uuid,uuid,timestamptz,uuid,integer,boolean) from public, anon')
    expect(migration).toContain('revoke all on function public.mutate_sygtasks(text,jsonb,uuid,integer) from public, anon')
    expect(migration).toContain('grant execute on function public.get_sygtasks_workspace(uuid,uuid,timestamptz,uuid,integer,boolean) to authenticated')
    expect(migration).toContain('grant execute on function public.mutate_sygtasks(text,jsonb,uuid,integer) to authenticated')
  })

  it('keeps workspace reads bounded, cursor-paginated, and contract-compatible', () => {
    expect(migration).toContain('target_page_size integer default 20')
    expect(migration).toContain('target_page_size not in (5, 10, 20, 50)')
    expect(migration).toContain('(task.updated_at, task.id) < (target_cursor_updated_at, target_cursor_task_id)')
    expect(migration).toContain('limit page_size + 1')
    expect(migration).toContain("'hasMore', has_more")
    expect(migration).toContain("'nextCursor'")

    for (const key of [
      'employeeId', 'permissions', 'boards', 'selectedBoard', 'tasks', 'myTasks',
      'labels', 'members', 'availableMembers', 'taskDetail', 'page',
    ]) {
      expect(migration).toContain(`'${key}'`)
    }

    for (const detailKey of ['watchers', 'checklistItems', 'comments', 'dependencies', 'activity']) {
      expect(migration).toContain(`'${detailKey}'`)
    }

    expect(migration).toContain('limit 100')
    expect(migration).toContain('limit 200')
    expect(migration).toContain('limit 50')
    expect(migration).toContain("account.disabled_at is null")
    expect(migration).toContain("employee.status = 'active'")
  })

  it('strictly allowlists bounded mutations and applies optimistic versions', () => {
    for (const action of actions) {
      expect(migration).toContain(`'${action}'`)
      expect(migration).toContain(`when '${action}' then array[`)
    }

    expect(migration).toContain("octet_length(clean_payload::text) > 65536")
    expect(migration).toContain("if clean_payload - allowed_payload_keys <> '{}'::jsonb")
    expect(migration).toContain('target_client_request_id is null')
    expect(migration).toContain('pg_advisory_xact_lock')
    expect(migration).toContain('sygtasks_action_requests_actor_request_unique')
    expect(migration).toContain('request_hash <> request_fingerprint')
    expect(migration).toContain("created_at > clock_timestamp() - interval '1 minute'")
    expect(migration).toContain('>= 120')

    const noWhitespace = compact.replace(/\s/g, '')
    expect((noWhitespace.match(/version=target_expected_version/g) ?? []).length).toBeGreaterThanOrEqual(7)
    expect(migration.match(/raise serialization_failure/g)?.length).toBeGreaterThanOrEqual(5)
  })

  it('preserves append-only activity and mirrors every material change into the audit trail', () => {
    expect(migration).toContain('create trigger sygtasks_activity_append_only')
    expect(migration).toContain('create trigger sygtasks_action_requests_append_only')
    expect(migration.match(/before update or delete on private\.sygtasks_/g)).toHaveLength(2)
    expect(migration).toContain("raise check_violation using message = 'SygTasks audit history is append-only.'")
    expect(migration).toContain('insert into private.sygtasks_activity')
    expect(migration).toContain('insert into private.audit_events')
    expect(migration).toContain("jsonb_build_object('before', before_record, 'after', after_record)")
  })

  it('creates one recipient notification per action and uses content-free realtime invalidations', () => {
    const notifyStart = migration.indexOf('create function private.sygtasks_notify(')
    const notifyEnd = migration.indexOf('create function private.sygtasks_task_json(', notifyStart)
    const notifyFunction = migration.slice(notifyStart, notifyEnd)

    expect(notifyFunction).toContain('private.create_employee_notification')
    expect(notifyFunction).toContain("concat('sygtasks:', target_actor_employee_id, ':', target_client_request_id, ':', target_recipient_employee_id)")
    expect(notifyFunction).not.toContain('private.signal_employee_update')
    expect(migration).not.toMatch(/insert into public\.employee_notification_email_deliveries/)
    expect(migration).toContain('create function private.sygtasks_signal_scope')
    expect(migration).toContain("jsonb_build_object(\n        'kind', 'sygtasks',\n        'boardId', target_board_id,\n        'taskId', target_task_id")
    expect(migration).toContain('perform private.sygtasks_signal_scope(board_id,task_id)')
    expect(migration).not.toContain("'title', task_record.title")
    expect(migration).not.toContain("'body', clean_body")
  })
})
