import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migration = readFileSync(
  join(
    root,
    "supabase",
    "migrations",
    "20260823123000_time_maintenance_operational_workday.sql",
  ),
  "utf8",
);
const timePage = readFileSync(
  join(root, "src", "pages", "TimePage.tsx"),
  "utf8",
);
const exceptionsPage = readFileSync(
  join(root, "src", "time", "TimeExceptionsPage.tsx"),
  "utf8",
);

describe("overnight Time Maintenance workday guard", () => {
  it("filters complete occurrences by their start-day assignment anchor", () => {
    expect(migration).toContain("get_effective_time_events_with_occurrence");
    expect(migration).toContain(
      "(occurrence.assignment_anchor at time zone 'America/Denver')::date",
    );
    expect(migration).toContain("'operationalDate', operational_date");
    expect(migration).not.toContain(
      "coalesce(latest_correction.replacement_time, event.recorded_at) at time zone 'America/Denver')::date\n+        between",
    );
  });

  it("shows workday ownership and opens correction tools in place", () => {
    expect(timePage).toContain(
      "Workday {formatDateOnly(event.operationalDate)}",
    );
    expect(timePage).toContain(
      'className="modal-dialog--time-workflow modal-dialog--time-correction"',
    );
    expect(timePage).toContain('title="Correct punch"');
    expect(timePage).toContain("Review this employee");
  });

  it("filters the exception workspace to the employee from the timecard link", () => {
    expect(exceptionsPage).toContain(
      "const focusedEmployeeId = searchParams.get('employee')",
    );
    expect(exceptionsPage).toContain(
      "rows.filter((row) => row.employeeId === focusedEmployeeId)",
    );
  });
});
