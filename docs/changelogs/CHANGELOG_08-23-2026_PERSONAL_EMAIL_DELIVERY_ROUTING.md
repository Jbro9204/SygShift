# SygShift Personal Email Delivery Routing

Date: 08/23/2026

## Outcome

SygShift now treats the temporary company-domain delivery block as a hard system rule. Employee email delivery uses a valid personal email first and does not send to `@guardianshipsecurity.net`.

## What changed

- Added one shared personal-first delivery rule for employee email selection.
- Updated welcome and login-instruction targets to prefer personal email and reject the blocked company domain.
- Prevented account creation and temporary-password resets when no approved delivery address exists.
- Updated announcement, schedule-publication, call-off, and automatic clock-out recipient queues to use the same personal-first rule.
- Kept the Worker provider boundary as a second independent safeguard so a blocked address cannot reach Cloudflare Email Sending even if it enters a queue unexpectedly.
- Updated Users & Access to display the actual approved delivery address and clearly request a personal email when none is available.
- Added regression tests for personal-first selection, exact-domain blocking, fallback behavior, bulk target reporting, and pre-provisioning rejection.

## Operational rule

This restriction remains active until the company email delivery issue is resolved and the domain is deliberately removed from both the database routing policy and the Worker blocked-domain configuration.

## Production verification

- Applied migration `20260823190000_personal_email_delivery_routing.sql` to the linked production database.
- Verified personal-first resolution and exact company-domain rejection in production.
- Passed the complete type, lint, test, and production-build suite: 63 test files and 326 tests.
- Deployed Cloudflare Worker version `9b5da939-b8f0-4686-b90c-a8bd88f19f0f`.
- Confirmed production health, readiness, and login-route checks after deployment.
