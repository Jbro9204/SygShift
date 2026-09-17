# Employee Conversations Workspace — September 17, 2026

## Release outcome

SygShift now includes a protected **Employee Conversations** workspace for supervisors and authorized HR reviewers to document routine conversations, coaching, and training without granting supervisors broad access to confidential Employee Files.

The workspace is live at:

- **Workforce → Employee Conversations**
- The authorized **Conversation** action in the employee directory
- The **Employee Conversations** tab shown beside an Employee File for authorized users

## Guided workflow

- A four-step, review-before-save flow identifies the employee, conversation type, date, factual notes, optional witnesses, and any follow-up.
- Authorized employee results populate directly in the guided picker; supervisors see only employees assigned to them, while qualified reviewers can work companywide.
- Plain-language writing guidance keeps notes factual and work-related.
- Routine records with no follow-up date save as complete. Records with a follow-up date remain open and visible in the follow-up queue.
- The timeline can be filtered, paged, and expanded without overwhelming the user.
- Follow-up notes, completion, reopening, and reasoned voiding are appended to the permanent history. Existing entries are never silently overwritten.

## Security and record boundaries

- Added dedicated permissions: `hr.conversations.view`, `hr.conversations.manage`, and `hr.conversations.review`.
- Supervisors receive view/manage access only for active direct reports established by the supervisor-assignment table.
- Operations managers, Human Resources roles, and system administrators can review companywide records.
- Every read and write requires an active account, a current MFA session, the applicable permission, and the employee-scope check at the database boundary.
- Authenticated users have no direct table access. Access is limited to the three purpose-built RPCs.
- Conversation and event history is held in private, indexed tables; event rows are append-only.
- Mutations write platform audit events. The production migration preserved employee, supervisor-assignment, corrective-action, attendance-accountability, time-event, and permission-override row counts.

This workspace intentionally does **not**:

- expose medical, payroll, tax, licensing, investigation, or unrelated Employee File content to supervisors;
- notify the employee automatically;
- create discipline, attendance points, payroll adjustments, or schedule changes;
- replace the existing formal corrective-action process.

## Database release

- Applied and recorded migration `20260917193852_employee_conversations_workspace.sql`.
- Created private conversation and append-only event tables plus the guarded read/create/action RPCs.
- Rollback-only regression covered authorized creation, follow-up history, completion, reopening, reasoned voiding, scope enforcement, MFA enforcement, role permissions, direct-table denial, and preservation counts.
- The regression completed successfully and rolled back all fixture data. Production contained `0` conversation rows and `0` event rows after release verification.
- Production postflight confirmed all three permissions active, authenticated RPC execution available, anonymous RPC execution denied, and authenticated direct-table reads denied.

## Verification

- Full application gate: **267 test files / 1,347 tests passed**, including type checking, linting, and the production build.
- Focused responsive Employee Conversations browser matrix: **4/4 passed** on desktop and mobile, with no horizontal overflow and zero automated accessibility violations.
- Combined Employee Conversations and mandatory Time Clock preservation matrix: **46/46 passed**.
- Production health and readiness returned HTTP `200` on both the primary and fallback origins, with every readiness dependency reported ready.
- Both origins served the same `EmployeeConversationsPage-DXa7BueD.js` bundle and the expected permanent-record, permission-boundary, and no-silent-overwrite copy.

## Release identifiers

- Implementation source: `60f9f88` (`Add protected employee conversations workspace`)
- Cloudflare Worker: `193c05a6-a217-451c-a770-f40780bea428`
- Rollback tag: `rollback/pre-employee-conversations-20260917` → `a711bef`
- Primary: <https://app.sygilant.us>
- Fallback: <https://sygshift.sygilant.workers.dev>
