import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { ClipboardList, Plus, RefreshCw, Settings2 } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  createSygTask,
  createSygTaskRecurringSeries,
  formatSygTaskStatus,
  getSygTasksWorklist,
  getSygTasksWorkspace,
  mutateSygTasks,
  sygTaskPath,
  type CreateSygTaskInput,
  type CreateSygTaskRecurringSeriesInput,
  type SygTask,
  type SygTaskAction,
  type SygTaskPriority,
  type SygTaskStatus,
  type SygTasksWorklistSummary,
  type SygTasksWorkspace,
} from '../data/sygtasks'
import { getSupabaseClient } from '../lib/supabase'
import {
  BoardRail,
  KanbanBoard,
  SygTasksHeader,
  SygTasksPrimaryTabs,
  SygTasksSummary,
  TaskTable,
  TaskToolbar,
  TasksEmptyState,
  WorklistPagination,
  type SygTasksMode,
  type SygTasksView,
} from '../components/sygtasks/SygTasksElements'
import {
  BoardSettingsDialog,
  CreateBoardDialog,
  CreateTaskDialog,
  SygTasksErrorNotice,
  SygTasksSuccessNotice,
  TaskDetailDialog,
} from '../components/sygtasks/SygTasksDialogs'
import '../styles/sygtasks.css'

const emptySummary: SygTasksWorklistSummary = {
  accessibleBoards: 0,
  current: 0,
  dueToday: 0,
  inProgress: 0,
  upcoming: 0,
  completedThisMonth: 0,
  timezone: 'America/Denver',
  asOf: new Date(0).toISOString(),
}

function uniqueTasks(pages: SygTasksWorkspace[] | undefined) {
  const seen = new Set<string>()
  return (pages?.flatMap((workspace) => workspace.tasks) ?? []).filter((task) => !seen.has(task.id) && Boolean(seen.add(task.id)))
}

function useStoredBoardView() {
  const [view, setViewState] = useState<SygTasksView>(() => {
    try { return sessionStorage.getItem('sygtasks.board-view') === 'list' ? 'list' : 'kanban' } catch { return 'kanban' }
  })
  const setView = (next: SygTasksView) => {
    setViewState(next)
    try { sessionStorage.setItem('sygtasks.board-view', next) } catch { /* Browsing remains usable when storage is disabled. */ }
  }
  return [view, setView] as const
}

function SygTasksLoading() {
  return <section className="sygtasks-loading" role="status" aria-live="polite"><img aria-hidden="true" src="/branding/sygtasks-emblem.png" alt="" /><RefreshCw aria-hidden="true" className="spin" size={22} /><strong>Opening SygTasks…</strong><span>Loading your authorized boards and work.</span></section>
}

export function SygTasksPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const boardId = params.get('board')
  const taskId = params.get('task')
  const [mode, setMode] = useState<SygTasksMode>(boardId ? 'boards' : 'my-work')
  const [view, setView] = useStoredBoardView()
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search.trim())
  const [statusFilter, setStatusFilter] = useState<SygTaskStatus | 'all'>('all')
  const [priorityFilter, setPriorityFilter] = useState<SygTaskPriority | 'all'>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<5 | 10 | 20 | 50>(20)
  const [createBoardOpen, setCreateBoardOpen] = useState(false)
  const [createTaskOpen, setCreateTaskOpen] = useState(false)
  const [boardSettingsOpen, setBoardSettingsOpen] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)

  const workspaceQuery = useInfiniteQuery({
    queryKey: ['sygtasks', 'workspace', boardId, taskId],
    queryFn: ({ pageParam }) => getSygTasksWorkspace({ boardId, taskId, cursor: pageParam, pageSize: 50 }),
    initialPageParam: null as { updatedAt: string; taskId: string } | null,
    getNextPageParam: (lastPage) => lastPage.page.nextCursor ?? undefined,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  })
  const workspace = workspaceQuery.data?.pages[0]
  const activeBoardId = boardId ?? (mode === 'boards' ? workspace?.selectedBoard?.id ?? null : null)
  const canLoadWorklist = Boolean(workspace && (mode === 'my-work' || activeBoardId))
  const worklistQuery = useQuery({
    queryKey: ['sygtasks', 'worklist', mode, activeBoardId, deferredSearch, statusFilter, priorityFilter, page, pageSize],
    queryFn: () => getSygTasksWorklist({
      mode: mode === 'my-work' ? 'my_work' : 'board',
      boardId: mode === 'boards' ? activeBoardId : null,
      search: deferredSearch,
      status: statusFilter === 'all' ? null : statusFilter,
      priority: priorityFilter === 'all' ? null : priorityFilter,
      page,
      pageSize,
    }),
    enabled: canLoadWorklist,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  })

  const invalidateSygTasks = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['sygtasks'] })
  }, [queryClient])
  const action = useMutation({
    mutationFn: ({ kind, payload, expectedVersion, clientRequestId }: { kind: SygTaskAction; payload: Record<string, unknown>; expectedVersion?: number; clientRequestId?: string }) => mutateSygTasks(kind, payload, { expectedVersion, clientRequestId }),
    onSuccess: invalidateSygTasks,
  })
  const createTaskAction = useMutation({
    mutationFn: ({ input, clientRequestId }: { input: CreateSygTaskInput; clientRequestId: string }) => createSygTask(input, { clientRequestId }),
    onSuccess: invalidateSygTasks,
  })
  const createRecurringAction = useMutation({
    mutationFn: ({ input, clientRequestId }: { input: CreateSygTaskRecurringSeriesInput; clientRequestId: string }) => createSygTaskRecurringSeries(input, { clientRequestId }),
    onSuccess: invalidateSygTasks,
  })

  useEffect(() => {
    setMode(boardId ? 'boards' : 'my-work')
  }, [boardId])
  useEffect(() => { setPage(1) }, [activeBoardId, deferredSearch, mode, pageSize, priorityFilter, statusFilter])
  useEffect(() => {
    const totalPages = worklistQuery.data?.page.totalPages
    if (typeof totalPages === 'number' && totalPages > 0 && page > totalPages) setPage(totalPages)
  }, [page, worklistQuery.data?.page.totalPages])
  useEffect(() => {
    if (!success) return
    const timeout = window.setTimeout(() => setSuccess(null), 6000)
    return () => window.clearTimeout(timeout)
  }, [success])
  useEffect(() => {
    if (!workspace?.employeeId) return
    const client = getSupabaseClient()
    let disposed = false
    let channel: ReturnType<typeof client.channel> | undefined
    let refreshTimer: number | undefined
    const refresh = () => {
      if (disposed || refreshTimer) return
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined
        if (!disposed) void invalidateSygTasks()
      }, 120)
    }
    void client.auth.getSession().then(async ({ data }) => {
      if (disposed || !data.session) return
      await client.realtime.setAuth(data.session.access_token)
      if (disposed) return
      channel = client.channel(`employee:${data.session.user.id}`, { config: { private: true } })
        .on('broadcast', { event: 'changed' }, refresh)
        .subscribe((status) => { if (status === 'SUBSCRIBED') refresh() })
    }).catch(() => undefined)
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    return () => {
      disposed = true
      if (refreshTimer) window.clearTimeout(refreshTimer)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('online', refresh)
      if (channel) void client.removeChannel(channel)
    }
  }, [invalidateSygTasks, workspace?.employeeId])

  const workspaceForDetail = useMemo(() => workspace ? { ...workspace, tasks: uniqueTasks(workspaceQuery.data?.pages) } : null, [workspace, workspaceQuery.data?.pages])
  const summary = worklistQuery.data?.summary ?? emptySummary
  const trustedReferenceTime = worklistQuery.data?.summary.asOf
  const authorizedBoards = worklistQuery.data?.boards ?? workspace?.boards ?? []
  const tasks = worklistQuery.data?.tasks ?? []
  const counts = worklistQuery.data?.counts.status ?? { backlog: 0, ready: 0, in_progress: 0, blocked: 0, review: 0, done: 0, canceled: 0 }
  const displayedCounts = statusFilter === 'all' ? counts : { backlog: 0, ready: 0, in_progress: 0, blocked: 0, review: 0, done: 0, canceled: 0, [statusFilter]: worklistQuery.data?.page.total ?? 0 }
  const filtered = Boolean(search.trim() || statusFilter !== 'all' || priorityFilter !== 'all')
  const selectedBoard = workspace?.selectedBoard
  const createTaskMembers = selectedBoard?.scope === 'company' && workspace?.permissions.manageShared
    ? workspace.availableMembers
    : workspace?.members ?? []
  const busy = action.isPending || createTaskAction.isPending || createRecurringAction.isPending
  const pageActionError = !createBoardOpen && !createTaskOpen && !boardSettingsOpen && !taskId
    ? action.error ?? createTaskAction.error ?? createRecurringAction.error
    : null

  const clearFilters = () => { setSearch(''); setStatusFilter('all'); setPriorityFilter('all'); setPage(1) }
  const openCreateBoard = () => { action.reset(); setCreateBoardOpen(true) }
  const openCreateTask = () => { createTaskAction.reset(); createRecurringAction.reset(); setCreateTaskOpen(true) }
  const openBoardSettings = () => { action.reset(); setBoardSettingsOpen(true) }
  const switchMode = (next: SygTasksMode) => {
    setSuccess(null)
    if (next === 'my-work') { setMode('my-work'); navigate('/tasks'); return }
    setMode('boards')
    const target = selectedBoard ?? authorizedBoards[0]
    if (target) navigate(sygTaskPath(target.id))
  }
  const openTask = (task: SygTask) => { setMode('boards'); navigate(sygTaskPath(task.boardId, task.id)) }
  const act = async (kind: SygTaskAction, payload: Record<string, unknown>, expectedVersion?: number) => {
    setSuccess(null)
    await action.mutateAsync({ kind, payload, expectedVersion })
  }
  const changeStatus = (task: SygTask, status: SygTaskStatus) => {
    void act('update_task', { taskId: task.id, status }, task.version)
      .then(() => setSuccess(`“${task.title}” moved to ${formatSygTaskStatus(status)}.`))
      .catch(() => undefined)
  }
  const refresh = () => {
    setSuccess(null)
    const request = canLoadWorklist
      ? Promise.all([
          workspaceQuery.refetch({ throwOnError: true }),
          worklistQuery.refetch({ throwOnError: true }),
        ])
      : workspaceQuery.refetch({ throwOnError: true })
    void request.then(() => setSuccess('SygTasks is up to date.')).catch(() => undefined)
  }

  if (workspaceQuery.isPending) return <SygTasksLoading />
  if (workspaceQuery.isError || !workspace) {
    return <section className="sygtasks-unavailable"><img aria-hidden="true" src="/branding/sygtasks-emblem.png" alt="" /><h1>SygTasks is unavailable</h1><SygTasksErrorNotice error={workspaceQuery.error} /><button type="button" className="sygtasks-button sygtasks-button--primary" onClick={() => void workspaceQuery.refetch()}>Try Again</button><p>Your other SygShift tools remain available.</p></section>
  }

  return (
    <section className="sygtasks-workspace" aria-labelledby="sygtasks-title">
      <SygTasksHeader fetching={workspaceQuery.isFetching || worklistQuery.isFetching} onCreateBoard={openCreateBoard} onRefresh={refresh} />
      <SygTasksPrimaryTabs mode={mode} taskCount={summary.current} boardCount={worklistQuery.data ? summary.accessibleBoards : workspace.boards.length} onChange={switchMode} />
      <SygTasksSuccessNotice message={success} />
      <SygTasksErrorNotice error={pageActionError} />
      {workspaceQuery.isRefetchError || worklistQuery.isRefetchError ? <SygTasksErrorNotice error={workspaceQuery.error ?? worklistQuery.error} /> : null}
      <div className={`sygtasks-layout${mode === 'my-work' ? ' sygtasks-layout--my-work' : ''}`}>
        {mode === 'boards' ? <BoardRail boards={authorizedBoards} selectedId={selectedBoard?.id} onAdd={openCreateBoard} onSelect={(board) => navigate(sygTaskPath(board.id))} /> : null}
        <section className="sygtasks-main">
          <header className="sygtasks-main__heading">
            <div><p>{mode === 'my-work' ? 'Personal focus' : selectedBoard?.scope ?? 'Workspace'}</p><h2>{mode === 'my-work' ? 'My Work' : selectedBoard?.name ?? 'Choose a board'}</h2><span>{mode === 'my-work' ? 'Tasks you own, follow, were assigned, or are responsible for reviewing.' : selectedBoard?.description || 'Work shared with this board.'}</span></div>
            {mode === 'boards' && selectedBoard ? <div>{selectedBoard.canManageBoard ? <button type="button" className="sygtasks-button sygtasks-button--secondary" onClick={openBoardSettings}><Settings2 aria-hidden="true" size={17} />Board Settings</button> : null}{selectedBoard.canCreateTask ? <button type="button" className="sygtasks-button sygtasks-button--primary" onClick={openCreateTask}><Plus aria-hidden="true" size={17} />New Task</button> : null}</div> : null}
          </header>
          {mode === 'my-work' ? <SygTasksSummary summary={summary} /> : null}
          {mode === 'boards' && !selectedBoard ? <div className="sygtasks-empty sygtasks-empty--board"><ClipboardList aria-hidden="true" size={34} /><h3>No board selected</h3><p>Create your first board or choose an authorized board from the rail.</p><button type="button" className="sygtasks-button sygtasks-button--primary" onClick={openCreateBoard}><Plus aria-hidden="true" size={17} />New Board</button></div> : <>
            <TaskToolbar mode={mode} search={search} status={statusFilter} priority={priorityFilter} view={view} onSearch={setSearch} onStatus={setStatusFilter} onPriority={setPriorityFilter} onView={setView} />
            {worklistQuery.isPending ? <div className="sygtasks-list-loading" role="status"><RefreshCw aria-hidden="true" className="spin" /><strong>Loading tasks…</strong><span>Finding the work you are authorized to view.</span></div> : worklistQuery.isError ? <div className="sygtasks-list-error"><SygTasksErrorNotice error={worklistQuery.error} /><button type="button" className="sygtasks-button sygtasks-button--primary" onClick={() => void worklistQuery.refetch()}>Try Again</button></div> : !tasks.length ? <TasksEmptyState filtered={filtered} onClear={clearFilters} /> : mode === 'boards' && view === 'kanban' ? <KanbanBoard tasks={tasks} counts={displayedCounts} referenceTime={summary.asOf} busy={busy} onOpen={openTask} onStatus={changeStatus} /> : <TaskTable tasks={tasks} referenceTime={summary.asOf} busy={busy} onOpen={openTask} onStatus={changeStatus} />}
            {worklistQuery.data ? <WorklistPagination page={worklistQuery.data.page.number} pageSize={worklistQuery.data.page.size} total={worklistQuery.data.page.total} totalPages={worklistQuery.data.page.totalPages} busy={worklistQuery.isFetching} onPage={setPage} onPageSize={setPageSize} /> : null}
          </>}
        </section>
      </div>
      {createBoardOpen ? <CreateBoardDialog allowShared={workspace.permissions.manageShared} busy={action.isPending} error={action.error} onClose={() => { setCreateBoardOpen(false); action.reset() }} onSubmit={(input, clientRequestId) => { setSuccess(null); void action.mutateAsync({ kind: 'create_board', payload: input, clientRequestId }).then((result) => { const createdBoardId = typeof result.boardId === 'string' ? result.boardId : null; setCreateBoardOpen(false); setSuccess('Board created successfully.'); setMode('boards'); if (createdBoardId) navigate(sygTaskPath(createdBoardId)) }).catch(() => undefined) }} /> : null}
      {createTaskOpen && selectedBoard ? <CreateTaskDialog boardName={selectedBoard.name} members={createTaskMembers} employeeId={workspace.employeeId} canAssignOthers={workspace.permissions.manageShared} busy={createTaskAction.isPending || createRecurringAction.isPending} error={createTaskAction.error ?? createRecurringAction.error} onClose={() => { setCreateTaskOpen(false); createTaskAction.reset(); createRecurringAction.reset() }} onSubmit={(input, clientRequestId, recurrence) => {
        const request = recurrence
          ? createRecurringAction.mutateAsync({ input: {
              boardId: selectedBoard.id,
              title: input.title,
              description: input.description,
              status: input.status === 'ready' || input.status === 'in_progress' ? input.status : 'backlog',
              priority: input.priority,
              assigneeId: input.assigneeId,
              ...recurrence,
            }, clientRequestId })
          : createTaskAction.mutateAsync({ input: { ...input, boardId: selectedBoard.id }, clientRequestId })
        void request.then(() => { setCreateTaskOpen(false); setSuccess(recurrence ? 'Recurring task created. The first occurrence is ready.' : 'Task created and the board is up to date.') }).catch(() => undefined)
      }} /> : null}
      {taskId && workspaceForDetail?.taskDetail ? <TaskDetailDialog key={`${workspaceForDetail.taskDetail.id}:${workspaceForDetail.taskDetail.version}`} workspace={workspaceForDetail} detail={workspaceForDetail.taskDetail} referenceTime={trustedReferenceTime} busy={action.isPending} error={action.error} canLoadMoreCandidates={Boolean(workspaceQuery.hasNextPage)} loadingMoreCandidates={workspaceQuery.isFetchingNextPage} onLoadMoreCandidates={() => { void workspaceQuery.fetchNextPage() }} onClose={() => { action.reset(); navigate(sygTaskPath(workspaceForDetail.taskDetail!.boardId)) }} act={act} /> : null}
      {boardSettingsOpen ? <BoardSettingsDialog workspace={workspace} busy={action.isPending} error={action.error} onClose={() => { setBoardSettingsOpen(false); action.reset() }} onArchived={() => { setBoardSettingsOpen(false); setMode('my-work'); setSuccess('Board archived. Its history remains preserved.'); navigate('/tasks') }} act={act} /> : null}
    </section>
  )
}
