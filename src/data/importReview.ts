import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

const candidateKindSchema = z.enum(['weekly_schedule', 'employee', 'site', 'shift'])
const candidateStatusSchema = z.enum(['pending', 'accepted', 'rejected', 'superseded'])
const candidateDecisionSchema = z.enum(['accepted', 'rejected', 'superseded'])
const issueSeveritySchema = z.enum(['information', 'warning', 'blocking'])
const sourceReferenceSchema = z.object({
  sheetIndex: z.number().int().nonnegative().optional(),
  sheetName: z.string().optional(),
  address: z.string().optional(),
}).passthrough()

const importReviewSummarySchema = z.object({
  importRunId: z.string().uuid(),
  status: z.enum(['registered', 'extracting', 'review', 'reconciled', 'promoted', 'failed']),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceFilename: z.string(),
  sourceCellCount: z.number().int().nonnegative(),
  candidateCount: z.number().int().nonnegative(),
  blockingIssueCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),
  reconciliationDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  createdAt: z.string(),
  candidateCounts: z.record(z.string(), z.number().int().nonnegative()),
  issueCounts: z.record(z.string(), z.number().int().nonnegative()),
})

const importCandidateSchema = z.object({
  id: z.string().uuid(),
  kind: candidateKindSchema,
  candidate_key: z.string(),
  confidence: z.enum(['review', 'blocking_review']),
  review_status: candidateStatusSchema,
  payload: z.record(z.string(), z.unknown()),
  source_references: z.array(sourceReferenceSchema),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  created_at: z.string(),
  total_count: z.number().int().nonnegative(),
})

const importIssueSchema = z.object({
  id: z.string().uuid(),
  severity: issueSeveritySchema,
  code: z.string(),
  message: z.string(),
  source_reference: sourceReferenceSchema.nullable(),
  related_sources: z.array(sourceReferenceSchema),
  resolution: z.string().nullable(),
  resolved_at: z.string().nullable(),
  total_count: z.number().int().nonnegative(),
})

export type CandidateKind = z.infer<typeof candidateKindSchema>
export type CandidateStatus = z.infer<typeof candidateStatusSchema>
export type CandidateDecision = z.infer<typeof candidateDecisionSchema>
export type IssueSeverity = z.infer<typeof issueSeveritySchema>
export type SourceReference = z.infer<typeof sourceReferenceSchema>
export type ImportReviewSummary = z.infer<typeof importReviewSummarySchema>
export type ImportCandidate = z.infer<typeof importCandidateSchema>
export type ImportIssue = z.infer<typeof importIssueSchema>

export const verifiedWorkbookBaseline = {
  sourceFilename: 'dispatch schedule-LAPTOP-DUUH2O4N.xlsx',
  sourceSha256: '5746f5e6c97a88e267cbb0feb5c6def0ad2a444ecc810d2adcbd997f1c356dc0',
  sheetCount: 155,
  sourceCellCount: 110_274,
  candidateCount: 9_408,
  blockingIssueCount: 132,
  warningCount: 60,
  reconciliationDigest: '8fc044c1cb969d2aa2f49ea43b5122f7e9d073dbb0314f65b8531e979c00d137',
} as const

export function parseImportReviewSummary(value: unknown): ImportReviewSummary | null {
  return importReviewSummarySchema.nullable().parse(value)
}

export function parseImportCandidates(value: unknown): ImportCandidate[] {
  return z.array(importCandidateSchema).parse(value)
}

export function parseImportIssues(value: unknown): ImportIssue[] {
  return z.array(importIssueSchema).parse(value)
}

export async function getImportReviewSummary(): Promise<ImportReviewSummary | null> {
  const { data, error } = await getSupabaseClient().rpc('get_import_review_summary')
  if (error) throw new Error('The protected import summary could not be loaded. Admin access with MFA is required.')
  return parseImportReviewSummary(data)
}

export async function getImportCandidatesPage(input: {
  importRunId: string
  kind: CandidateKind | null
  status: CandidateStatus | null
  limit: number
  offset: number
}): Promise<ImportCandidate[]> {
  const { data, error } = await getSupabaseClient().rpc('get_import_candidates_page', {
    target_import_run_id: input.importRunId,
    target_kind: input.kind,
    target_review_status: input.status,
    page_size: input.limit,
    page_offset: input.offset,
  })
  if (error) throw new Error('Import candidates could not be loaded for review.')
  return parseImportCandidates(data)
}

export async function getImportIssuesPage(input: {
  importRunId: string
  severity: IssueSeverity | null
  resolved: boolean
  limit: number
  offset: number
}): Promise<ImportIssue[]> {
  const { data, error } = await getSupabaseClient().rpc('get_import_issues_page', {
    target_import_run_id: input.importRunId,
    target_severity: input.severity,
    target_resolved: input.resolved,
    page_size: input.limit,
    page_offset: input.offset,
  })
  if (error) throw new Error('Import issues could not be loaded for review.')
  return parseImportIssues(data)
}

export async function reviewImportCandidate(input: {
  candidateId: string
  decision: CandidateDecision
  note: string
}): Promise<void> {
  const { error } = await getSupabaseClient().rpc('review_import_candidate', {
    target_candidate_id: input.candidateId,
    target_decision: input.decision,
    target_note: input.note,
  })
  if (error) throw new Error('This candidate could not be reviewed. Refresh and confirm it is still pending.')
}

export async function resolveImportIssue(input: { issueId: string; resolution: string }): Promise<void> {
  const { error } = await getSupabaseClient().rpc('resolve_import_issue', {
    target_issue_id: input.issueId,
    target_resolution: input.resolution,
  })
  if (error) throw new Error('This issue could not be resolved. Refresh and confirm it is still open.')
}
