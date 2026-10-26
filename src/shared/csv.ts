/**
 * CSV for exports (RFC 4180, CRLF). Every cell is quoted. Text that a spreadsheet would run as a
 * formula (starts with = + - @, tab or carriage return) gets a leading apostrophe, so a customer
 * named "=HYPERLINK(...)" stays plain text. Plain numbers such as "-12.34" are left as numbers.
 */
const NUMBER = /^-?\d+(\.\d+)?$/;
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string | number | null | undefined): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (FORMULA_START.test(text) && !NUMBER.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(rows: readonly (readonly (string | number | null | undefined)[])[]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

/** Paise as rupees with integer maths: -1234 → "-12.34". */
export function csvRupees(paise: number): string {
  const abs = Math.abs(paise);
  return `${paise < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** File-name-safe text. */
export function csvFileName(text: string): string {
  return text.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "export";
}
