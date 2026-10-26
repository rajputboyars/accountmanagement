import { describe, expect, it } from "vitest";
import { csvCell, csvRupees, toCsv } from "@/shared/csv";
import { MAX_RANGE_DAYS, rangeQuery, resolveRange } from "@/shared/report-range";

const today = "2026-10-26";

describe("report ranges", () => {
  it("resolves the presets in India business dates", () => {
    expect(resolveRange({}, today)).toMatchObject({ preset: "today", from: today, to: today, days: 1 });
    expect(resolveRange({ range: "yesterday" }, today)).toMatchObject({ from: "2026-10-25", to: "2026-10-25" });
    expect(resolveRange({ range: "7d" }, today)).toMatchObject({ from: "2026-10-20", to: today, days: 7 });
    expect(resolveRange({ range: "month" }, today)).toMatchObject({ from: "2026-10-01", to: today, days: 26 });
    expect(resolveRange({ range: "yesterday" }, "2026-03-01")).toMatchObject({ from: "2026-02-28" });
    expect(resolveRange({ range: "custom", from: "2026-09-30", to: "2026-10-01" }, today)).toMatchObject({ preset: "custom", days: 2, problem: null });
  });

  it("falls back to today with a reason for bad custom ranges", () => {
    expect(resolveRange({ range: "custom", from: "2026-10-05" }, today).problem).toBe("Choose both dates for a custom range.");
    expect(resolveRange({ range: "custom", from: "2026-10-05", to: "2026-10-01" }, today).problem).toMatch(/on or before/);
    expect(resolveRange({ range: "custom", from: "2026-10-05", to: "2026-10-27" }, today).problem).toMatch(/future/);
    expect(resolveRange({ range: "custom", from: "2026-02-30", to: "2026-03-01" }, today).problem).toMatch(/both dates/);
    expect(resolveRange({ range: "custom", from: "2024-01-01", to: today }, today).problem).toBe(`Choose at most ${MAX_RANGE_DAYS} days.`);
    expect(resolveRange({ range: "custom", from: "2026-10-05", to: "2026-10-27" }, today)).toMatchObject({ preset: "today", from: today });
  });

  it("builds links that keep the range", () => {
    expect(rangeQuery({ preset: "7d", from: "", to: "" })).toBe("range=7d");
    expect(rangeQuery({ preset: "custom", from: "2026-10-01", to: "2026-10-02" })).toBe("range=custom&from=2026-10-01&to=2026-10-02");
  });
});

describe("csv", () => {
  it("quotes cells and neutralises spreadsheet formulas", () => {
    expect(csvCell('Say "hi"')).toBe('"Say ""hi"""');
    for (const bad of ["=1+1", "+91 cmd", "-2+3", "@SUM(A1)", "\tx", "\rx"]) expect(csvCell(bad)).toBe(`"'${bad}"`);
    expect(csvCell("-12.34")).toBe('"-12.34"');
    expect(csvCell(null)).toBe('""');
    expect(toCsv([["a", 1], ["b", 2]])).toBe('"a","1"\r\n"b","2"');
  });

  it("formats paise as rupees without floats", () => {
    expect(csvRupees(-1234)).toBe("-12.34");
    expect(csvRupees(5)).toBe("0.05");
    expect(csvRupees(100000000)).toBe("1000000.00");
  });
});
