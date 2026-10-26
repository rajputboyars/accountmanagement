import { describe, expect, it } from "vitest";
import { autoMap } from "@/modules/imports/service";
import { csvCell } from "@/shared/csv";
import { CsvParseError, parseCsv, unescapeFormulaCell } from "@/shared/csv-parse";

describe("parseCsv", () => {
  it("reads quotes, escaped quotes, commas and newlines in fields, CRLF and a BOM", () => {
    expect(parseCsv('﻿name,note\r\n"Elbow 1""","a, b"\r\n"two\nlines",x\r\n\r\n')).toEqual([
      ["name", "note"],
      ['Elbow 1"', "a, b"],
      ["two\nlines", "x"],
    ]);
  });

  it("rejects an unclosed quote but keeps inch marks inside plain fields", () => {
    const lines = (...rows: string[]) => rows.join(String.fromCharCode(10));
    expect(() => parseCsv(lines("a", '"open'))).toThrow(CsvParseError);
    expect(parseCsv(lines("a", 'Pipe 1" (3 m),x'))).toEqual([["a"], ['Pipe 1" (3 m)', "x"]]);
  });

  it("round-trips our formula-safe export cells", () => {
    const exported = csvCell("=HYPERLINK(1)");
    const [[cell]] = parseCsv(exported);
    expect(unescapeFormulaCell(cell!)).toBe("=HYPERLINK(1)");
    expect(unescapeFormulaCell("'plain")).toBe("'plain");
  });

  it("maps common header names to template fields", () => {
    expect(autoMap("products", ["Item Name", "Item Code", "UOM", "HSN", "GST %", "MRP", "Wholesale", "Cost"])).toMatchObject({ name: 0, sku: 1, base_unit: 2, hsn: 3, gst_rate: 4, retail_price: 5, wholesale_price: 6, cost_price: 7, category: null });
  });
});
