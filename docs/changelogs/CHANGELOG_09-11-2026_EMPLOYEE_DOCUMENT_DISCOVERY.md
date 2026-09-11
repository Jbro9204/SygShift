# Employee Document Discovery

**Date:** 09/11/2026  
**Status:** Released and verified in production

## Outcome

Documents filed to an employee now have an obvious home on that employee's record. Opening an Employee File presents a prominent **Files for [employee]** card, and **Open employee files** goes directly to a document inventory filtered to that person instead of dropping the user into the general Document Center.

## Why the file was hard to find

- The Employee File showed a document count, but its Documents link opened the unfiltered company-wide `/hr/documents` route.
- The general Document Studio dashboard occupied the top of that route, so the actual inventory could be below the fold.
- Opening the filing workbench from a person-specific context did not preselect that employee.
- A file that was already durably saved could therefore appear to have disappeared even though it was present in the employee document inventory.

## Repair

- Added a large, rounded Employee documents card near the top of every authorized Employee File.
- Added the employee's current file count and a direct **Open employee files** action.
- Deep-linked the Document Center with the employee ID and legal name, while keeping authorization decisions on the existing server-enforced employee and vault permissions.
- Replaced the general Document Studio dashboard with a focused employee header when the route is opened from an Employee File.
- Moved the filtered inventory to the top of that focused view and labeled it **Files for [employee]**.
- Added clear **Employee File**, **Add document**, and **View all documents** actions.
- Made **Add document** preselect and lock onto the employee from whom the workflow was launched, including a prefilled employee search field.
- Kept pending background-processing uploads visible in the employee inventory so a saved document does not appear to vanish.
- Preserved the employee selection in the URL and filter control, including records that are no longer in the active-employee picker but remain authorized historical files.
- Added responsive light/dark presentation with stacked mobile actions, readable 44-pixel-or-larger controls, and no horizontal overflow.

## Scope and safety

- No database migration was required.
- No production employee, document, schedule, timekeeping, or audit data was changed or deleted.
- No permission, recent-HR-MFA, vault, storage, validation, malware scanning, preview, download, or audit boundary was weakened or bypassed.
- Invalid or unauthorized employee identifiers continue through the existing safe workspace and permission boundaries.
- Scheduling, Clock In/Out, Early Clock-In, SygSphere, notifications, password recovery, and every other application module were unchanged by the release.

## Verification

- Focused component and guard verification: 5 files / 21 tests passed.
- Complete repository gate: 250 test files / 1,279 tests passed; TypeScript, zero-warning lint, Worker build, and client production build passed.
- Employee document discovery, workbench, and Employee File responsive browser matrix: 18/18 passed on desktop and mobile in light and dark modes, including accessibility and overflow checks.
- Complete browser gate: 320 tests passed, 10 intentionally skipped duplicate SygTasks mobile-project cases, and zero failed.
- Pre-release Time Clock and Early Clock-In matrix: 46/46 passed across desktop and mobile.
- Post-release Time Clock and Early Clock-In matrix: 46/46 passed across desktop and mobile.
- Both `https://app.sygilant.us` and `https://sygshift.sygilant.workers.dev` returned HTTP 200 for health, readiness, and `/hr/documents`; readiness reported every required check ready.
- The live entry JavaScript, global stylesheet, HR Documents bundle, and Employee File bundle matched the fresh release build byte-for-byte on both production origins.

## Release record

- Source commit: `9b58ed8` (`feat: surface employee-file documents`).
- Cloudflare Worker version: `487412dd-230e-4054-8820-53c32512606a`.
- Pre-release rollback tag: `rollback/pre-employee-document-discovery-20260911` at `26de511828c5b0ea0c515d8daf749116a54daf8f`.

## Files

- `src/pages/HrisEmployeeFilePage.tsx`
- `src/pages/HrisDocumentsPage.tsx`
- `src/components/DocumentWorkbench.tsx`
- `src/App.css`
- `src/components/DocumentWorkbench.test.tsx`
- `src/components/DocumentWorkspaceRecovery.test.tsx`
- `src/hrisComprehensiveEmployeeFileGuard.test.ts`
- `tests/e2e/employee-document-discovery-layout.spec.ts`

## Recovery

The prior application release can be restored with `rollback/pre-employee-document-discovery-20260911`. No database rollback is needed because this release contains no migration and made no data changes.
