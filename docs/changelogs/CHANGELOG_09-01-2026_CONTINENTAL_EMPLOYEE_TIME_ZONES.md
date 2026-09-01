# Continental U.S. Employee Schedule Time Zones

Date: 09/01/2026  
Status: Released to production

## Outcome

Employees can follow assigned shifts in their own Eastern, Central, Mountain, or Pacific time zone without changing the secure UTC timestamp that controls the shift, clock-in window, time card, or payroll record.

Zach Ward's employee profile fallback is now Central Time. His existing shift today was not rewritten: the 7:00 AM Mountain occurrence remains the same absolute instant and now presents to him as 8:00 AM Central.

## Employee experience

- Home, My Time, and the employee schedule display personal shift times in the supported time zone reported by the employee's browser.
- When the browser does not report one of the four supported zones, the employee profile time zone is used.
- Scheduled times and the forced early-clock-in acknowledgment identify the display time zone clearly.
- Clock eligibility continues to compare the server's authoritative current time with the shift's absolute timestamp; changing a computer clock cannot open the clock-in window.

## Scheduling behavior

- Authorized staff can maintain an employee's Eastern, Central, Mountain, or Pacific profile time zone in User Accounts.
- Future one-person assigned shifts are entered in the selected employee's profile time zone and converted to a secure absolute timestamp by the database.
- Open coverage, multi-person coverage, and general Site/Post shifts continue to use the Site/Post operating time zone.
- New shift records preserve whether their time-zone authority came from a Site/Post, an employee profile, or an explicit existing source.

## Safety boundaries

- Existing shifts, time events, active clock sessions, workday ownership, payroll assignments, and payroll history were not rewritten.
- The migration fingerprints every existing shift and time event before the change and raises an error, rolling back the transaction, if any fingerprint or row count changes.
- Zach's existing shift today was deliberately preserved; only his employee profile fallback time zone was set to `America/Chicago`.
- User Accounts saves profile changes and time-zone changes through one audited database transaction.
- The existing five-minute early-clock-in rule remains server-enforced.
- Payroll week ownership remains governed by the existing Mountain Time payroll policy.

## Verification

- The isolated Supabase dry run identified exactly one pending migration.
- Production applied only `20260901190000_continental_employee_time_zones.sql`.
- The migration's preservation assertions passed in production.
- Type checking passed.
- Lint passed with zero warnings.
- 129 test files and 640 tests passed.
- Worker and client production builds passed.
- Wrangler deployment dry run and production deployment passed.
- Deployed Cloudflare Worker version: `400b7dbe-cd07-4e6b-9d4e-7a7a5c8781cb`.
- Production app, login, health, and readiness endpoints returned HTTP 200; readiness reported all required bindings healthy.

## Operating note

Other remote employees should have the correct profile time zone selected in User Accounts. A supported browser will display personal shifts locally automatically, and the profile value provides the controlled fallback and the authority for future employee-specific schedule entry.
