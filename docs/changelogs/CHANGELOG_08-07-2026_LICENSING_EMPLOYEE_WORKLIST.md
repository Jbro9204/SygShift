# SygShift Change Log - Licensing Employee Worklist

Date: 08/07/2026

## Summary

The Licensing Center worklist now shows one consolidated row per employee instead of repeating the employee once for every license or credential. Individual credentials remain separate, complete, and editable inside the employee's Licensing Profile.

## What changed

- Grouped filtered licensing records by employee for the main worklist.
- Added a concise license and credential count with a short preview of the records on file.
- Added the employee's nearest credential expiration and overall compliance status to the summary row.
- Added a count of active renewal workflows.
- Preserved credential type, compliance, employment status, summary-card, and text-search filtering.
- Preserved the complete credential history and all credential editing controls inside each Licensing Profile.
- Kept one clear action per employee: Open credential profile.

## Quality assurance

- TypeScript type check: passed
- Lint with warnings denied: passed
- Automated tests: 166 passed across 35 test files
- Production build: passed
- Database migration: not required

## Expected behavior

Employees with several licenses now appear once in the Credential Worklist. Opening the employee's profile still shows every individual license and credential as its own record for review, renewal, document management, and editing.
