# SygShift Change Log — Permission-Aware Navigation

**Date:** 08/28/2026  
**Area:** Navigation, Home, Time & Attendance, announcements, operational alerts  
**Risk level:** Access-control user experience

## What changed

- Controls are now shown only when the signed-in employee is authorized to open the exact destination route.
- Review Queue visibility now follows the `/time/review` route policy everywhere it appears.
- Team Attendance, Time Operations, Daily Attendance Review, Accountability, and Payroll links follow their own route policies rather than broader helper checks.
- The primary sidebar and Time workspace tabs now use the same canonical route-access policy as the route guard.
- Announcement action buttons are hidden when the employee can read the announcement but cannot access its linked workflow.
- High-priority attendance alerts are hidden from employees who cannot open their target workflow, and the shell no longer requests those operational alerts for unauthorized users.
- Review Queue sub-navigation hides Daily Reconciliation or exception views independently when the employee lacks access to either destination.

## What did not change

- No role definitions were changed.
- No employee role assignments were changed.
- No individual grants or denials were changed.
- No payroll, punch, schedule, or employee data was changed.
- Route authorization remains enforced by the existing application access policy.

## User experience result

Employees no longer see workflow buttons that send them back to Home because access is unavailable. If a person cannot open a destination, the associated navigation item or action is not rendered.

## Verification

- Added route-policy coverage for accountability-only and exception-review access boundaries.
- Added a permission-aware route-visibility regression suite covering the shell, Home, Time workspace, Team Attendance, Review Queue, announcements, and operational alerts.
- Confirmed targeted access-control and Home regression tests pass.
- Confirmed TypeScript compilation passes.
