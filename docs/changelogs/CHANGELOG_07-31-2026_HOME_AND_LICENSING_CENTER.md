# SygShift Changelog — 07/31/2026

## Home and Licensing Center cleanup

### Completed

- Renamed the main navigation item from **Overview** to **Home**.
- Updated supporting user-facing copy so employee-facing language refers to **Home** instead of **Overview**.
- Removed the duplicate employee-directory-style list from the Licensing Center.
- Removed the Licensing Center **Employee list / Credential list** switch so the page stays focused on licensing and credentialing work.
- Changed the Licensing Center table heading to **Credential worklist**.
- Changed the credential row action from **Open profile** to **Open credential profile** so the purpose is clearer.
- Changed **Add onboarding employee** to **Add onboarding profile** to avoid making the Licensing Center feel like a second employee directory.
- Updated Licensing Center search copy to focus on credentials, license numbers, employees, status, and location.
- Removed unused Licensing Center employee-list styles and stale guardrails.

### Quality checks

- Lint passed.
- Production build passed.
- Full test suite passed: 149 tests across 32 files.

### Notes

- The Licensing Center still shows the employee name on each credential row for context, but employee directory management remains outside the Licensing Center.
- Licensing Center is now intended to function as the credential and license work area, not a second Directory.
