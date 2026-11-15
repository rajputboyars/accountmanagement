/**
 * Bank statements: reading a CSV with a column mapping, telling real duplicates from genuinely identical transactions,
 * suggesting matches and the reconciliation arithmetic. Pure (no database, no Node): whole paise and plain strings only,
 * so every rule can be tested on its own. Nothing here posts anything; suggestions only ever help the owner choose.
 */

export const DATE_FORMATS = ["dmy", "mdy", "ymd"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

/** Which CSV column (0 is the first) holds what. Debit and credit are separate columns, as most Indian bank statements have them. */
export type CsvMapping = {
  hasHeader: boolean;
  dateFormat: DateFormat;
  dateColumn: number;
  narrationColumn: number;
  debitColumn: number;
  creditColumn: number;
  balanceColumn: number | null;
  referenceColumn: number | null;
};

export type ParsedStatementLine = { row: number; txnDate: string; narration: string; reference: string | null; debitPaise: number; creditPaise: number; balancePaise: number | null };
export type StatementProblem = { row: number; message: string };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (value: number) => String(value).padStart(2, "0");

function realDate(year: number, month: number, day: number): string | null {
  if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${year}-${pad(month)}-${pad(day)}`;
  return new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso ? iso : null;
}

/** Reads "05/11/2026", "5-Nov-26", "2026-11-05" and the like. Returns null when the text is not a real date, never a guess. */
export function parseStatementDate(raw: string, format: DateFormat): string | null {
  const text = raw.trim().replace(/\s+/g, " ");
  if (!text) return null;
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(text);
  if (iso) return realDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const named = /^(\d{1,2})[-/ .]([A-Za-z]{3})[A-Za-z]*[-/ .,]*(\d{2}|\d{4})(?:[ T].*)?$/.exec(text);
  if (named) {
    const month = MONTHS.indexOf(named[2]!.toLowerCase()) + 1;
    if (month === 0) return null;
    const year = Number(named[3]);
    return realDate(year < 100 ? 2000 + year : year, month, Number(named[1]));
  }
  const numeric = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:[ T].*)?$/.exec(text);
  if (!numeric) return null;
  const [a, b] = [Number(numeric[1]), Number(numeric[2])];
  const year = Number(numeric[3]);
  const fullYear = year < 100 ? 2000 + year : year;
  if (format === "mdy") return realDate(fullYear, a, b);
  return realDate(fullYear, b, a);
}

/** "1,234.50", "₹ 500", "(250.00)" into whole paise. Empty means zero. Anything else, or more than two decimals, is not an amount. */
export function parseStatementAmount(raw: string): number | null {
  let text = raw.trim().replace(/[₹\s]/g, "").replace(/^rs\.?/i, "").replace(/,/g, "");
  if (!text || text === "-") return 0;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1);
  }
  text = text.replace(/(dr|cr)$/i, "");
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const paise = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(paise)) return null;
  return negative ? -paise : paise;
}

/** The bank's own reference (UTR / RRN / cheque number) found inside a narration, if there is one. */
export function extractReference(narration: string): string | null {
  const labelled = /(?:UTR|RRN|REF(?:ERENCE)?(?:\s*NO)?|CHQ(?:\s*NO)?|CHEQUE(?:\s*NO)?|IMPS|NEFT|RTGS)[\s:./-]*([A-Z0-9]{6,22})/i.exec(narration);
  if (labelled && /\d/.test(labelled[1]!)) return labelled[1]!.toUpperCase();
  const digits = /\b\d{9,18}\b/.exec(narration);
  return digits ? digits[0] : null;
}

const cell = (row: string[], index: number | null) => (index === null ? "" : (row[index] ?? "").trim());

/** Turns the CSV rows into statement lines and a list of rows that could not be read. Nothing is skipped silently. */
export function parseStatement(rows: readonly string[][], mapping: CsvMapping): { lines: ParsedStatementLine[]; problems: StatementProblem[] } {
  const lines: ParsedStatementLine[] = [];
  const problems: StatementProblem[] = [];
  rows.forEach((row, index) => {
    if (index === 0 && mapping.hasHeader) return;
    const number = index + 1;
    if (row.every((value) => value.trim() === "")) return;
    const txnDate = parseStatementDate(cell(row, mapping.dateColumn), mapping.dateFormat);
    if (!txnDate) return void problems.push({ row: number, message: "The date could not be read." });
    const debit = parseStatementAmount(cell(row, mapping.debitColumn));
    const credit = parseStatementAmount(cell(row, mapping.creditColumn));
    if (debit === null || credit === null) return void problems.push({ row: number, message: "The debit or credit amount could not be read." });
    if (debit < 0 || credit < 0) return void problems.push({ row: number, message: "Debit and credit amounts cannot be negative." });
    if (debit > 0 && credit > 0) return void problems.push({ row: number, message: "A line has both a debit and a credit." });
    if (debit === 0 && credit === 0) return void problems.push({ row: number, message: "A line has no amount." });
    const balance = mapping.balanceColumn === null || cell(row, mapping.balanceColumn) === "" ? null : parseStatementAmount(cell(row, mapping.balanceColumn));
    if (mapping.balanceColumn !== null && cell(row, mapping.balanceColumn) !== "" && balance === null) return void problems.push({ row: number, message: "The balance could not be read." });
    const narration = cell(row, mapping.narrationColumn).replace(/\s+/g, " ");
    const reference = cell(row, mapping.referenceColumn) || extractReference(narration);
    lines.push({ row: number, txnDate, narration, reference: reference ? reference.toUpperCase() : null, debitPaise: debit, creditPaise: credit, balancePaise: balance });
  });
  return { lines, problems };
}

/**
 * The text two statement lines must share to be "the same transaction". Identical lines inside one file are numbered
 * (1, 2, ...) so two genuine identical payments on one day are both kept, while the same line seen again in an overlapping
 * statement is recognised: it has the same text and the same number.
 */
export function lineKey(line: { txnDate: string; debitPaise: number; creditPaise: number; reference: string | null; narration: string }): string {
  return [line.txnDate, line.debitPaise, line.creditPaise, line.reference ?? "", line.narration.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()].join("|");
}

/** Numbers repeats of the same key in file order: the first is 1, the next identical one is 2, and so on. */
export function withOccurrences<T extends { txnDate: string; debitPaise: number; creditPaise: number; reference: string | null; narration: string }>(lines: readonly T[]): (T & { key: string; occurrence: number })[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const key = lineKey(line);
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    return { ...line, key, occurrence };
  });
}

// ── Suggested matches ──────────────────────────────────────────────────────────────────────────────

/** Signed from the bank account's point of view: money in is +, money out is -. */
export const signedLine = (line: { debitPaise: number; creditPaise: number }) => line.creditPaise - line.debitPaise;

export type BookItem = { id: string; signedPaise: number; date: string; reference: string | null; label: string; partyName: string | null; method: string | null };
export type Suggestion = { itemIds: string[]; score: number; reasons: string[]; kind: "match" | "settlement" };

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const dayNumber = (value: string) => Math.floor(new Date(`${value}T00:00:00Z`).getTime() / 86_400_000);

/** Single-item suggestions for one statement line: the same amount in the books, scored by reference, date and name. Never applied automatically. */
export function suggestDirectMatches(line: { txnDate: string; debitPaise: number; creditPaise: number; narration: string; reference: string | null }, items: readonly BookItem[]): Suggestion[] {
  const amount = signedLine(line);
  const narration = norm(line.narration);
  const out: Suggestion[] = [];
  for (const item of items) {
    if (item.signedPaise !== amount) continue;
    let score = 60;
    const reasons = ["Same amount"];
    if (item.reference && (line.reference === item.reference.toUpperCase() || narration.includes(norm(item.reference)))) {
      score += 30;
      reasons.push("Same reference number");
    }
    const days = Math.abs(dayNumber(line.txnDate) - dayNumber(item.date));
    if (days <= 1) {
      score += 10;
      reasons.push("Same or next day");
    } else if (days <= 3) {
      score += 6;
      reasons.push("Within 3 days");
    } else if (days <= 7) {
      score += 3;
      reasons.push("Within a week");
    }
    const party = item.partyName ? norm(item.partyName).split(" ").filter((word) => word.length >= 4) : [];
    if (party.some((word) => narration.includes(word))) {
      score += 10;
      reasons.push("Name appears in the statement");
    }
    out.push({ itemIds: [item.id], score, reasons, kind: "match" });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** The most a settlement fee can plausibly be before the owner is asked to look twice (3% of what was settled). */
export const LARGE_FEE_BP = 300;

/**
 * Suggests which waiting UPI, card or cheque receipts a bank credit settles. Gateways pay out the oldest unsettled receipts
 * first, less their fee, so each method is tried oldest-first and the smallest fee (zero or more, up to 3%) is suggested.
 * A cheque is tried on its own first. The owner confirms or changes it; this never posts.
 */
export function suggestSettlement(line: { txnDate: string; debitPaise: number; creditPaise: number }, items: readonly BookItem[]): Suggestion | null {
  const net = signedLine(line);
  if (net <= 0) return null;
  let best: Suggestion | null = null;
  let bestFee = Infinity;
  const methods = [...new Set(items.map((item) => item.method).filter((method): method is string => method === "upi" || method === "card" || method === "cheque"))];
  for (const method of methods) {
    const waiting = items.filter((item) => item.method === method && item.signedPaise > 0 && item.date <= line.txnDate).sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date.localeCompare(b.date)));
    const single = method === "cheque";
    let gross = 0;
    const ids: string[] = [];
    for (const item of waiting) {
      if (single) {
        if (item.signedPaise === net) return { itemIds: [item.id], score: 90, reasons: ["Cheque amount matches"], kind: "settlement" };
        continue;
      }
      gross += item.signedPaise;
      ids.push(item.id);
      const fee = gross - net;
      if (fee < 0) continue;
      if (fee * 10_000 > gross * LARGE_FEE_BP) break;
      const score = fee === 0 ? 85 : 70;
      if (fee < bestFee) {
        bestFee = fee;
        best = { itemIds: [...ids], score, reasons: [fee === 0 ? "Settles these receipts exactly" : "Settles these receipts, less a fee"], kind: "settlement" };
      }
      break;
    }
  }
  return best;
}

// ── Reconciliation ─────────────────────────────────────────────────────────────────────────────────

export type ReconciliationInput = {
  /** The closing balance the bank statement shows on the end date. */
  statementBalancePaise: number;
  /** What the books hold in this account at the end of that date. */
  bookBalancePaise: number;
  /** Statement balance and book balance on the day the account was added; their difference is carried, never hidden. */
  openingStatementPaise: number;
  openingBookPaise: number;
  /** Recorded in the books but not yet on the statement: + deposits still on their way, - payments not yet cleared. */
  bookNotInBankPaise: number;
  /** On the statement but not yet decided: + credits, - debits. Must be nothing before a reconciliation is finished. */
  bankNotInBooksPaise: number;
};

/**
 * The statement should equal the books, less what the bank has not seen yet, plus what the books have not seen yet,
 * plus whatever difference the account started with. Anything left over is the difference to explain.
 */
export function reconciliationDifference(input: ReconciliationInput): number {
  const expected = input.bookBalancePaise - input.bookNotInBankPaise + input.bankNotInBooksPaise + (input.openingStatementPaise - input.openingBookPaise);
  return input.statementBalancePaise - expected;
}

/** Whole-sentence explanation of the figures for the owner. */
export function explainDifference(differencePaise: number): "balanced" | "bank_has_more" | "books_have_more" {
  if (differencePaise === 0) return "balanced";
  return differencePaise > 0 ? "bank_has_more" : "books_have_more";
}
