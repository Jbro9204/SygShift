# Floating patrol property approval — 11/21/2026

Status: local candidate. No hosted migration, app deployment, property grant, or live assignment change.

- In **Patrol Command Center → Operations → Floating patrol properties**, choose a published shift and its assigned guard. Select and save the properties Dispatch can send them to. The result is shown as verified only after an exact readback. A lost save response does not replay the approval.
- Approval is per employee and published shift. It is append-only, records who approved the properties and why, checks the reviewed revision, and never grants Operations or company-wide site access. Clearing and saving the list revokes floating access without deleting existing reports.
- Properties must be active and linked to an active client. The saved client must still match the property when the guard starts a report. A client reassignment cannot turn an old approval into new access.
- A replacement shift or different employee is not approved by inference. Operations reviews the new exact assignment. Scheduled native routes and static coverage keep their existing behavior. A floating reporting list does not generate ordered route stops, hit obligations, or any schedule/time/payroll changes.

## Cross-app release

Apply and verify SygShift `20261121203920_floating_patrol_shift_scope.sql` before Sygilant `20261121211000_sygilant_floating_patrol_report_authority.sql` on the shared database. Verify the exact candidates, release Sygilant before showing the new Operations controls in SygShift, and configure no production approval until both apps and the new boundary are live. Keep the additive database audit records on app rollback; pause new approvals and coordinate a forward-only repair if needed.

The complete local `pnpm release:verify` passed: 2,685 application tests (one existing skip), 395 isolated PostgreSQL patrol lifecycle assertions, all 42 mandatory desktop/mobile Time Clock checks, and a fresh production build. Separate verification passed 20 desktop/mobile light/dark Chromium route and property-approval cases and 779 cross-app PostgreSQL assertions. Production Guard Mode acceptance remains outstanding.
