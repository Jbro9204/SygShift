# Approved Workflow Quick Wins Release

**Release date:** September 9, 2026  
**Status:** Released to production  
**Source commits:** `ddc8506`, `0ec878f`  
**Rollback tag:** `rollback/quick-wins-pre-release-20260909`  
**Cloudflare Worker version:** `fc6a1ae7-0829-4254-8a77-2d728175f7ab`

## Outcome

The six approved quick wins were completed and released as one controlled production update. The release improves readability and day-to-day workflow clarity, repairs additive report access, makes personal task boards private by enforcement, adds secure username recovery, and standardizes protected PDF viewing without changing schedules, punches, payroll records, employee records, role assignments, MFA enrollment, or passwords.

## Released changes

### 1. My Time Snapshot readability

- Increased the summary labels for Today, This Week, Pay Period, and Needs Review.
- Increased their supporting descriptions so the cards remain readable without altering totals or time calculations.

### 2. Employee Lifecycle case controls

- Kept **New case** as a dedicated create action.
- Added **Manage** directly to each pending case row.
- Opening Manage carries the selected case into the existing controlled action workflow instead of making the user rediscover it.

### 3. Forgot Username

- Added a functioning **Forgot username?** path to the login page.
- Uses one generic response whether or not an eligible account exists, preventing username/account discovery.
- Rate limits requests and records only hashed email and request-fingerprint values in the recovery-request ledger.
- Sends an audited reminder through the approved SygShift email path only when the server confirms an active eligible account.
- Does not reset or alter the password, MFA, security keys, trusted devices, employee profile, or access.

### 4. Reports and additive roles

- Centralized report-library route permissions so effective permissions from all assigned roles are honored.
- Authorized report-domain access includes general reports, Time reporting, Licensing, Patrol reporting/management, and Client activity/management.
- Report export by itself does not grant visibility.
- Time report workspaces continue to require the dedicated Time reporting permission.

### 5. Personal SygTasks board privacy

- Personal boards are owner-only.
- Removed the member-management experience from personal-board settings and replaced it with a clear **Private to you** state.
- Enforced ownership in database visibility helpers, direct board writes, task mutation paths, membership/assignment/watcher paths, Realtime recipients, and notification recipients.
- Existing team and company board collaboration remains unchanged.

### 6. SygSphere PDF viewing

- Replaced the embedded browser PDF frame with SygShift's centralized secure PDF viewer.
- Protected SygSphere PDFs now use the same authenticated, CSP-compatible rendering path as the rest of the application.
- Existing document authorization, auditing, and download behavior remain intact.

## Production database release

Migration `20260910070000_secure_forgot_username_and_personal_board_privacy.sql` was applied and marked in production history.

Verified production controls:

- Username-recovery ledger exists with row-level security enabled and forced.
- Username claim is executable by the service role and not by employee/browser roles.
- Four personal-board mutation guards are installed.
- Eighteen real cross-owner manager/personal-board combinations were checked.
- Zero managers could view another employee's personal board.

No employee, schedule, timekeeping, payroll, role-membership, or document record was rewritten during the release.

## Verification completed

- Full repository check: **220 test files / 1,100 tests passed**.
- TypeScript build passed.
- ESLint passed with zero warnings.
- Targeted quick-win coverage: **71 tests passed**.
- Mandatory `tests/e2e/time-clock-workflow.spec.ts` browser suite passed.
- A fresh production build was generated after the browser suite.
- Production `/api/v1/health`: HTTP 200, `ok`.
- Production `/api/v1/ready`: HTTP 200, `ready`, all listed checks true.
- Live entry asset matched the fresh release build: `/assets/index-DgZ4wVp-.js`.
- Live username-recovery request returned the generic HTTP 202 accepted contract for a nonexistent test address.

## Recovery

The application rollback point is tag `rollback/quick-wins-pre-release-20260909`. Database changes are additive and should remain in place during an application rollback unless a separate reviewed data-security recovery plan requires otherwise.
