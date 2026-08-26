# SygShift Change Log — System Status and Maintenance Communication

Date: 08/26/2026

## Summary

SygShift now presents platform health at the appropriate level for each audience. Employees see one compact, plain-language status indicator, while authorized administrators can review sanitized system checks in System Operations. Completed maintenance notices now use calm language and clear themselves automatically.

## Employee-facing changes

- Removed the large technical data-connection banner from Home.
- Added a compact sidebar service indicator with three states:
  - Online
  - Attention Needed
  - Service Disruption
- Replaced internal maintenance verification wording with: “Maintenance complete. SygShift is available normally.”
- Added a manual close control for upcoming and completed maintenance notices.
- Completed notices automatically close after 15 seconds.
- Dismissal is remembered for the specific maintenance event so the same notice does not return during page navigation or a later session.
- Active maintenance notices remain persistent until maintenance ends.

## Administrator changes

- Added a protected Service Health section to System Operations.
- Added sanitized checks for application delivery, data and authentication, protected integrations, and safe release controls.
- Added an on-demand Refresh Checks action and a Mountain Time last-checked timestamp.
- Kept secret keys, private connection values, and request diagnostics out of the browser interface.

## Safety and quality

- Existing server-enforced maintenance restrictions remain unchanged.
- Existing role and permission assignments remain unchanged.
- Existing update-available and unsaved-work protection remain unchanged.
- Added automated coverage for status derivation, employee-safe completion language, automatic dismissal, persistent dismissal, active-notice persistence, and technical-language placement.
- TypeScript validation and the complete automated test suite passed before release.

## Production

- Production URL: https://app.sygilant.us
- Cloudflare release: `9a5858d8-8f86-47f2-9965-3c6da6c65298`
- Git release: `Improve system status communication`
- Production health and readiness checks passed on the custom domain; Worker fallback health also passed.
