# SygShift Change Log — Payroll Web Week Separation and Preview Download

Date: 08/24/2026

## What changed

- The on-screen payroll summary now displays separate Sunday-through-Saturday payroll-week sections rather than one combined two-week employee table.
- Each weekly section shows its own total payable hours, employee count, and employee-level regular, overtime, worked, break, sick/PTO, and payable totals.
- Opening an employee from a weekly section now shows only that employee's detail for the selected payroll week.
- The browser summary and downloaded workbook now use one shared weekly grouping and total-calculation source.
- Overnight work stays in the payroll week containing the authoritative scheduled start or clock-in, including Saturday-night shifts that end Sunday morning.

## Download reliability

- The preview download now validates that a nonempty workbook was created before starting the browser download.
- The temporary download element is attached to the document while it is used.
- The workbook object URL remains valid for 60 seconds so Chrome and Edge have time to complete the save.
- The page now shows download progress, success, and a clear error message when a preview cannot be produced.

## Workbook safety

- Workbook XML now removes characters that are illegal in Excel and Google Sheets worksheet XML.
- XML-sensitive text remains correctly escaped.
- Automated tests parse every generated worksheet and verify that the workbook download lifecycle remains valid.

## Data safety

- No production punch, schedule, payroll, locked-export, or audit-history records were changed.
- This update changes presentation and download delivery only; it does not change recorded hours or payroll arithmetic.

## Verification

- Type checking passed.
- Lint passed.
- 72 test files / 369 tests passed.
- Production build passed.
- Workbook XML/package validation passed.
- Git whitespace validation passed.
