# Unified 30-Minute HR MFA Window

**Date:** 09/11/2026
**Status:** Released and verified in production

## Outcome

One successful authenticator or security-key verification now opens one fixed 30-minute window across every HR area the employee is otherwise authorized to use. Moving between HR modules, opening employee records, refreshing, filing or downloading documents, signing, and completing other protected HR actions no longer creates separate repeat prompts during that window. After 30 minutes, the next protected request opens one verification checkpoint and resumes automatically after success.

## Experience and coordination

- Replaced module-specific HR prompt codes and the former 10/15-minute HR document exceptions with one `recent_hr_mfa_required` boundary and one 30-minute maximum age.
- Added an HR-specific checkpoint that explains the shared window and preserves the current page and entered information.
- Kept one in-page pending verification for simultaneous requests and added cross-tab coordination with the Web Locks and BroadcastChannel browser APIs.
- A successful verification in one tab releases waiting protected requests in sibling tabs from the same authentication session; no MFA token or reusable authorization grant is written to local storage.
- Cancellation remains fail-closed and returns the original protected denial without retrying or changing application state.

## Server and database enforcement

- Added a service-only verification function that binds proof to the active employee and current Supabase authentication session.
- Authenticator proof comes from the signed session assurance claim. Security-key proof comes from an unrevoked, unexpired session record tied to the same employee and authentication session.
- A fixed timestamp starts the window; ordinary activity and navigation do not extend it.
- Password changes, password-reset issuance, and MFA resets invalidate older proof. Logout, session expiration/revocation, account disablement, and normal authentication enforcement prevent further use.
- Existing role, permission, record-scope, maker-checker, reason, document, storage, scan, and audit checks continue to execute on every protected action. The shared window changes prompt frequency only.
- Rejected window use is logged without factor secrets, one-time codes, reusable security-key tokens, or authentication-session identifiers.

## HR coverage

- People and Employee File, including identity, contact, employment, and date maintenance.
- Employment Data Readiness, Recruiting, Onboarding, Leave, Benefits, and Compensation.
- Talent, Learning, Employee Cases, Safety, Assets, Offboarding, Self-Service, Reporting, and the payroll-integration control plane.
- HR operational actions and the HR automation/action workspace.
- Document Center, HR document library and workflows, My Documents, My Signature, document access, filing, delivery, signing, and audit certificates.

## Production data and migration

- Applied forward migration `20260912100000_unified_thirty_minute_hr_mfa_window.sql` after an isolated linked dry-run because the production migration ledger contains later remote-only history.
- Added three lookup indexes and one service-only verification function, and aligned the current HR database enforcement helpers to 30 minutes.
- No employee, document, signature, schedule, timekeeping, payroll, ticket, notification, role, permission, or access-control row was inserted, updated, or deleted by the release.
- A rollback-scoped production contract probe accepted current authenticator evidence, rejected 31-minute-old evidence, confirmed browser roles cannot call the service verifier, and ended with a database rollback.

## Verification

- Complete repository gate passed: TypeScript, zero-warning lint, 241 test files / 1,237 tests, Worker build, and client production build.
- Focused HR window, identity-coordinator, trigger, and modal suite passed 20/20 after the final source adjustment.
- Pre-release browser matrix passed 90/90 across desktop Chromium and Pixel 7 mobile dimensions, covering HR and document layouts, password recovery, shell behavior, and the actual Time Clock and Early Clock-In workflows.
- Post-release Time Clock and Early Clock-In matrix passed 46/46 across desktop and mobile. Guard, Admin, Dispatcher, and Supervisor clock-out/break controls remained present, and duplicate-punch prevention remained intact.
- Both `https://app.sygilant.us` and `https://sygshift.sygilant.workers.dev` returned healthy and ready responses. The protected HR-window endpoint rejected an unauthenticated request with HTTP 401 on both origins.
- The live main JavaScript, stylesheet, People data bundle, Employee File bundle, HR Documents bundle, and HR Stage 7 bundle matched the final local production build byte-for-byte by SHA-256.

## Release record

- Source commit: `99ed1e2` (`feat: unify HR MFA verification window`).
- Cloudflare Worker version: `227c7dea-68c4-4639-94cf-a8f3f5ce3125`.
- Pre-release fallback tag: `rollback/pre-unified-hr-mfa-window-20260911` at `e332cdfa6cbaeb9eb1d0a84431b6841e6505c433`.
- Live assets and verified SHA-256 hashes:
  - `index-CQmDbpnC.js`: `C25025F3DAC872F13D7DAC82050E11A230ABF747BF8AB43CA7B5ABD36C3B95B2`
  - `index-CG9TRMke.css`: `4A8E7578E511D91CBCA95BE03185E62BE8B0C710D3847A1FE082BC80A03947BE`
  - `hrisPeople-DGQWvFgc.js`: `5533C40F1F9A92D9EF07CE76091E9C8B48036C0E0C4C4C6FA3ADD10F3E835D9B`
  - `HrisEmployeeFilePage-b9COZ0Uh.js`: `AF60CBB33C6CA35593EF115CEF4B68D0A6255909A740C00780A21F35767AB185`
  - `HrisDocumentsPage-BXPt6CSe.js`: `A5B0DE030C58B177CA518A46210B2DF47CDFF13575D95103C1E1C18BDAC53787`
  - `HrisStage7Page-Bm6mwbD3.js`: `3DFAB7E7E6960473D30E09FBF565597A1EE70BAD2830E05A13734D0CF69AD173`

## Recovery

The application can be restored to the last fully verified source with `rollback/pre-unified-hr-mfa-window-20260911`. The database migration is forward-only and remains compatible with the prior application: it adds the new verifier and indexes while retaining existing function signatures and enforcement. No production business records require data recovery.
