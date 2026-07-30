# SygShift Future Items

Use this file for ideas we want to keep visible but are not building yet.

Keep this repo copy in sync with:
`C:\Users\Jordan\Desktop\SygShift Future Items\FUTURE_ITEMS.md`

Maintenance rule:
When a future item is implemented, record it in the proper changelog/devlog, then remove it from this active future list so this file stays current.

## Active / Recently Closed

### Employee Time & Attendance Self-View
Status: Completed 07/29/2026

Outcome:
Employees can view their own Time & Attendance without exposing supervisor payroll review tools.

### Users & Access Account Activity Filters
Status: Completed 07/29/2026

Idea:
Let admins filter by account setup and activity status so rollout issues are easier to find.

Notes:
- Built filters should use real account activity data only.
- Email delivery filters require persisted welcome/login email send timestamps before they are added.

### Multi-Day Manual Shift Creation
Status: Completed 07/29/2026

Idea:
Schedulers need to add the same shift to multiple days without recreating it one day at a time.

Notes:
- Keep this limited to the selected schedule week until a full recurring-shift preview and approval flow is designed.
- The UI must show the dates being created before save.

## Pinned For Later

### Time & Attendance Full Rebuild / Time Command Center
Status: Pinned for phased build
Added: 07/30/2026

Goal:
Rebuild Time & Attendance into a clean, professional timekeeping system that is easy for employees, supervisors, schedulers, and admins to use without crowding everything onto one screen.

Completed phases:
- Phase 1 - Foundation and Time Command Center completed 07/30/2026.
- Phase 2 - Employee My Time completed 07/30/2026.

Non-negotiables:
- Preserve all existing punches, edits, active clock-ins, payroll history, and audit history.
- Employees must be able to view their own time and attendance.
- Hourly employee time must come from real clock activity, approved manual corrections, and verified payroll review.
- Salary payroll defaults should calculate 40 hours per week unless approved time off or an approved payroll adjustment changes it.
- Payroll weeks run Sunday 12:00 AM through Saturday 11:59 PM.
- Overtime rules must support more than 12 hours in a day and more than 40 hours in a week.
- Breaks are unpaid, with a normal 30-minute break expectation.
- All dates must display as MM/DD/YYYY.
- Time should display in normal time plus military time where useful, such as 2:00 PM (14:00).
- Every save must show a loading state, complete cleanly, and refresh the affected view/modal immediately.
- Every payroll-impacting change must have an audit trail.

Phase 1 - Foundation and Time Command Center:
- Create a dedicated Time Command Center instead of one overloaded Time & Attendance page.
- Add clear navigation for My Time, Team Time, Exceptions, Payroll Review, and Exports.
- Keep existing time data intact and map old records into the new views.
- Add role-based visibility so Guards see their own time, while approved operations/admin roles see the proper management tools.
- Add visible loading states and immediate refetch/update behavior for every time save action.

Phase 3 - Supervisor / Scheduler Team Time:
- Add team and employee filters.
- Allow approved users to review employee time without exposing payroll-only tools.
- Show missing punches, unscheduled punches, long shifts, time off conflicts, and location issues.
- Allow punch location/site correction when time is tied to Unscheduled Location.

Phase 4 - Corrections and Audit Trail:
- Build a clean punch correction workflow with original value, new value, reason, changed by, and changed at.
- Support missing punch creation, punch edits, break corrections, site/location edits, and notes.
- Make every correction immediately visible after save.
- Prevent silent overwrites.

Phase 5 - Payroll Review:
- Create a payroll review workspace organized by pay period.
- Separate ready, needs review, and blocked records.
- Add salary default handling and time off deductions.
- Add payroll lock/close behavior so reviewed periods are not accidentally changed.
- Add a large weekly reminder for Admins/Supervisors to export time for HR/Finance.

Phase 6 - Payroll Export:
- Build a clean export flow for HR/Finance.
- Export approved hours, overtime, salary defaults, unpaid breaks, corrections, and notes.
- Keep export history with who exported, when, and for what pay period.

Phase 7 - QA and Guardrails:
- Add tests for payroll rules, overtime, salary defaults, break handling, missing punches, active punches, corrections, and export totals.
- Add UI checks for button alignment and form layout in every time modal/page.
- Add regression checks so save buttons, date/time fields, and modal refresh behavior do not break again.

### Accountability Tracker
Status: Pinned for later

Idea:
Allow approved operations users to mark call-offs, late arrivals, and early departures on a shift, with a reliability view per employee.

Requirements before build:
- Protected / state-mandated sick time must be explicitly excluded from negative reliability counts.
- Every entry needs an audit trail showing who recorded it and when.
- Employee-facing language must be careful and professional.
- Reports should separate operational history from payroll/timekeeping records.

### Supervisor Assignment / Scoped Visibility
Status: Pinned for later

Idea:
Add an Assigned Supervisor field to employee profiles so supervisors can default to seeing only their own employees instead of the full company.

Notes:
- Keep access permissions separate from employee visibility scope.
- Admins should still see everyone.
- Decide whether assignment should be employee-based, site/post-based, or both.
- Consider views for All employees, My employees, Unassigned, and By supervisor.

### Indeed Employer / Recruiting Depot
Status: Pinned for later

Idea:
Explore whether Indeed Employer can connect into SygShift/Sygilant through an API or integration, then use that connection to support a Recruiting Depot.

Notes:
- Goal is to better organize applicants, recruiting stages, licensing progress, and onboarding handoff.
- Need to confirm Indeed Employer API access, permissions, costs, and data limits.
- If direct API access is not realistic, evaluate email parsing, CSV import, or manual intake as fallback options.

### Role-Based Welcome/Login Emails and Clear MFA Setup Instructions
Status: Pinned for later

Idea:
Create role-specific welcome/login emails and make MFA setup language much clearer for roles that require MFA.

Notes:
- Welcome emails and login credential emails should stay separate.
- Emails should explain role-specific expectations for Guards, Supervisors, Schedulers, Dispatchers, Recruiting & Licensing, and Admins.
- MFA-required emails should clearly state that users must install an authenticator app before setup.
- Recommended authenticator apps: Microsoft Authenticator or Google Authenticator.
- First-time MFA setup screen should use large, plain language explaining that SygShift does not text the authenticator code; the authenticator app generates a new 6-digit code.
- Add clear instructions: install the app, open the app, choose Add Account / Scan QR Code, scan the SygShift QR from inside the authenticator app, then enter the 6-digit code shown in the app.
- Add a warning that scanning the QR code with the normal phone camera may not complete setup.
