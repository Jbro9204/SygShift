# Guided HR assignment handoff — 11/25/2026

Status: local release candidate; production activation and signed-in acceptance have not occurred.

- Guided Sygilant Coaching and Corrective Action assignment notices can open the protected **My HR tasks** page in a separate tab. The link contains no record ID, credential or session assertion.
- The associated shared database migration is owned by Sygilant. It keeps the existing private notification, email queue, deduplication and audits, while directing only the new signature-required forms to Sygilant. Those forms do not block SygShift sign-in or timekeeping. Existing corrective forms retain their Action Center workflow.
- Sygilant's sign-in and required permissions are unchanged. If asked to sign in, employees can go to **People & HR → My HR tasks** after login. This change does not register the fixed production link as a staged-auth handoff; test staging with its own task URL and a test email sink.
- The outbound link is allowlisted only for an exact corrective-action notice marker. Existing dispatch, report, required-action and local notification links are unchanged.
- All 30 focused notification routing and rendered-control tests passed. Local database acceptance also verified both form types without contacting an email provider.
