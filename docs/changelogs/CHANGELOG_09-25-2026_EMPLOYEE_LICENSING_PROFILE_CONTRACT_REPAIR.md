# Employee Licensing Profile Contract Repair

Date: 09/25/2026
Status: Released to production

## Outcome

Employee Licensing profiles now load when a credential has protected management
fields intentionally removed from the self-service response. This repairs the
error Eliot Olivarria reported and protects every employee who has one or more
credentials on file.

## Root cause

The production database correctly removes `internalNotes` and
`lastEmployeeNotification` from employee self-service credential records.
Those fields belong only in the authorized management Licensing workspace.

The browser was reusing the management credential validator, which still
required both keys to exist even when their values were nullable. Employees with
credential rows therefore received raw validation failures instead of their
Licensing profile. Empty profiles could load, which is why the release smoke
check did not expose the mismatch.

This was a response-contract defect. It was not caused by Eliot's account,
permissions, credential data, or MFA state.

## Repair

- Added a dedicated employee credential contract that deliberately excludes
  both management-only fields.
- Updated the employee Licensing components to use that narrower contract
  throughout profile display, renew/update, and protected-document viewing.
- Applied the same safe parser to initial load, draft save, submission,
  withdrawal, and refreshed profile responses.
- Replaced raw validation diagnostics with concise recovery guidance if a future
  unexpected response shape reaches the browser.
- Preserved the management Licensing contract and the database redaction
  boundary; protected fields were not made optional or added back to employee
  payloads.

## Regression protection

- Added a realistic two-credential client regression matching the shape that
  exposed Eliot's failure.
- Verified employee payloads with the protected keys absent are accepted.
- Verified any accidentally returned protected keys are stripped before the
  employee workspace can use them.
- Verified malformed payloads never expose raw validation internals.
- Extended the rollback-only database regression to populate a protected
  reviewer note and Licensing communication, then prove both keys are absent
  from every employee credential payload.

## Verification

- Full `pnpm check` passed: 308 test files / 1,626 tests, strict TypeScript,
  zero-warning application/Worker lint, production builds, and static-asset
  validation.
- The focused Licensing contract and employee self-service guard suite passed
  8/8.
- Mandatory actual-component Time Clock preservation matrix passed 42/42 across
  desktop and mobile.
- Both production origins returned HTTP 200 for health, readiness, and the
  Licensing route; readiness reported every required binding ready.
- The live application, stylesheet, and Licensing Center bundle were
  byte-identical to the verified production build.
- Authenticated production verification loaded the existing Team Licensing
  Center and the employee **My Licenses & Credentials** workspace without
  creating or changing any employee record.

## Release references

- Source commit: `c010b0d9593c6ef909f390480da73e4a7931d1fd`
- Cloudflare Worker version:
  `05127f91-f783-45c1-9e97-7335037ebd6b`
- Database migration: none required
- Rollback tag:
  `rollback/pre-employee-licensing-profile-contract-repair-20260925`
- Verified application asset: `/assets/index-CmC_IBC4.js`
  (`C80857F7D81E528BDB9C1D4BC0D8B877E0655D65B6DDD03A34AA5FF219AE0DFB`)
- Verified stylesheet: `/assets/index-VKZYXlD9.css`
  (`94FFE5C2AE5DA0F8EFB1157D42BB2205F879CEA3F7CC4C8CFEC29CC3E42550AE`)
- Verified Licensing Center asset:
  `/assets/LicensingCenterPage-CAoDKmou.js`
  (`DCF1D262388B7A9BB0F6DD784A26FF199BD6F62892E7F4B796E9C2BE2A3380D6`)

## Operator note

Employees with saved credentials should refresh SygShift and open
**Licensing Center > My Licenses & Credentials**. Existing credentials,
documents, eligibility decisions, HR notes, schedules, timekeeping, and account
permissions were not changed.

