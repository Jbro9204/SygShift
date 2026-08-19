# SygShift Prominent Employee Call-Off Action

Date: 08/19/2026

## Outcome

Employees can now reach the existing protected sick/call-off workflow directly from a prominent full-width panel on Home.

## Changes

- Replaced the small operations-oriented Home link with a dedicated **Can’t work your shift?** panel directly below the employee's live clock status.
- Added a clear **Report Sick / Call-Off** action with high-contrast styling, readable explanatory language, and a mobile layout that expands the action to the full available width.
- Routed the Home action to the employee's own My Time workflow instead of the general operations page.
- Added direct-form routing so the sick/call-off modal opens automatically when the employee uses the Home action.
- Preserved the existing business rule that the employee remains assigned until coverage is approved.
- Preserved automatic Dispatch notification and the server-side rule that the signed-in employee can report only for their own employee record.
- Added regression coverage protecting the prominent placement, direct modal behavior, and dedicated responsive styling.

## Verification

- Type checking passed.
- Linting passed with zero warnings.
- All 48 test files passed with 261 tests.
- Production build completed successfully.
- Deployed to Cloudflare Worker version `f71db72e-2090-49e7-a93b-183f45a36f30`.

## Production URL

https://app.sygilant.us
