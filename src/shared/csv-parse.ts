/**
 * CSV reading for imports (RFC 4180: quoted fields, "" escapes, CRLF or LF, a leading BOM ignored).
 * A quote inside an unquoted field is kept as text (item names like 1" pipe). Pure; the server enforces size and row limits before and after parsing.
 */
export class CsvParseError extends Error {}

export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else {
        if (char === "\n") line += 1;
        field += char;
      }
      continue;
    }
    if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      line += 1;
    } else field += char;
  }
  if (quoted) throw new CsvParseError(`Line ${line}: a quoted field is not closed.`);
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully empty lines (trailing newlines, spacer rows).
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

/** Undo the apostrophe our own exports add before formula-like text, so a round trip is lossless. */
export function unescapeFormulaCell(value: string): string {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}
