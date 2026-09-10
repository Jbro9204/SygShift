# SygSphere Direct Document Upload Repair

Date: 09/10/2026

## Outcome

SygSphere document sharing is again a single working action. Ordinary documents and images now travel through SygShift's existing same-origin upload endpoint, and the attachment is not reported as shared until the Worker has received, validated, stored, checked, and published it to the conversation. The broken intermediate message telling employees that secure storage was still confirming the file has been removed.

## Root cause corrected

- Production evidence for the reported PDF showed an authorized upload record in `prepared` state but no corresponding storage object and no scan attempt.
- The browser-to-storage signed upload path could report transfer completion even when the object never arrived. The completion call then correctly found nothing to finish, leaving the employee in a confirmation loop that could never succeed.
- The old **Finish upload** action only repeated that completion check. It did not resend the selected bytes, so it could not recover the missing object.

## Application changes

- Routed every supported attachment through 25 MB through the existing authenticated same-origin `PUT /api/v1/sygsphere/files/:fileId` Worker endpoint.
- The Worker continues to verify conversation membership, enforce size and actual-file-type limits, hash and store the file, run the existing scanner, and create the conversation message only after the file passes.
- Kept the signed resumable transfer path only for supported JPEG, PNG, and WebP images over 25 MB through the existing 100 MB image limit.
- Replaced the false completion-only recovery with a real retry: the selected `File` stays in the modal and **Retry upload** sends its bytes again.
- Removed the **Finish upload** state and the employee-facing secure-storage/quarantine wording from the normal sharing flow.
- The modal now reports **Sharing your file...** while work is in progress and **Your file has been shared.** only after the server returns a clean published result.
- Preserved request references on upload errors, including the Worker's `x-request-id`, so an actual failure remains traceable without exposing implementation details to employees.

## Preservation boundary

- No database migration or production-data rewrite was required.
- No storage policy, row-level security policy, role, permission, MFA, conversation membership, message history, notification, schedule, timekeeping, payroll, HR, or employee record was changed.
- Upload authorization and the file scanner remain in place behind the interface; they no longer create a manual confirmation step for valid files.
- Existing supported types and size limits remain unchanged: PDF, text, DOCX, XLSX, JPEG, PNG, and WebP through 25 MB, with supported JPEG/PNG/WebP images through 100 MB.
- Unauthorized callers remain unable to use the protected upload endpoint.

## Verification

- Focused SygSphere unit and experience-guard tests: 36/36 passed.
- Targeted desktop/mobile upload browser regressions: 6/6 passed, including transfer of actual PDF bytes before success and a failed first transfer followed by a real byte-for-byte retry.
- `pnpm check` passed TypeScript, zero-warning application lint, 234 test files, 1,207 tests, the Worker build, and the production client build.
- Combined SygSphere and mandatory actual-component Time Clock browser matrix: 92/92 desktop/mobile checks passed.
- Post-deployment mandatory Time Clock workflow: 42/42 desktop/mobile checks passed, including Early Clock-In acknowledgment and the clock-in, break, and clock-out controls.
- Primary and fallback production health returned `ok`; readiness returned `ready`; `/sygsphere` returned HTTP 200 on both origins.
- The live main asset `assets/index-WPafOdvx.js` matches the verified production build byte-for-byte on both origins, contains the direct SygSphere upload route, and does not contain the broken confirmation copy.
- A signed-out request to the protected direct-upload endpoint returned HTTP 401.

## Release

- Application source: `8bb1622` (`fix: make SygSphere document uploads reliable`).
- Cloudflare Worker version: `2a4387ec-9f4f-4de2-9894-9721dbba7304`.
- Primary URL: `https://app.sygilant.us`.
- Fallback URL: `https://sygshift.sygilant.workers.dev`.

## Rollback

- Pre-release source tag: `rollback/pre-sygsphere-direct-document-upload-20260910` at `66e1346`.
- This is an application-only release. If containment is required, restore the tagged application source and redeploy with the existing bindings preserved.

