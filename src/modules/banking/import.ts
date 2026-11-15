import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { saveCsvMapping } from "@/modules/accounting";
import { recordAudit } from "@/modules/audit";
import { requirePermission, type SessionContext } from "@/modules/identity";
import { getDb, withTransaction } from "@/server/db";
import { ConflictError, ValidationError } from "@/server/errors";
import { DATE_FORMATS, parseStatement, withOccurrences, type CsvMapping, type ParsedStatementLine, type StatementProblem } from "@/shared/bank";
import { CsvParseError, parseCsv } from "@/shared/csv-parse";
import { actorOf, BANK_MANAGE, loadBank, requireBooks, type Db } from "./common";
import { bankStatementLines, bankStatements } from "./schema";

/**
 * Importing a bank statement CSV. The owner says which column is what (saved for the account); the file is checked and shown
 * before anything is saved. Saving only records the statement's lines. It never creates a payment or a journal.
 * The same file cannot be imported twice, and a line already seen in an earlier, overlapping statement is recognised and skipped,
 * while two genuinely identical lines in one statement are both kept.
 */

const MAX_CHARS = 5_000_000;
const MAX_LINES = 20_000;
const column = z.coerce.number().int().min(0).max(60);

export const csvMappingSchema = z.object({
  hasHeader: z.boolean().default(true),
  dateFormat: z.enum(DATE_FORMATS).default("dmy"),
  dateColumn: column,
  narrationColumn: column,
  debitColumn: column,
  creditColumn: column,
  balanceColumn: z.preprocess((value) => (value === "" || value === null || value === undefined ? null : value), column.nullable()),
  referenceColumn: z.preprocess((value) => (value === "" || value === null || value === undefined ? null : value), column.nullable()),
});

export const importInputSchema = z.object({
  bankAccountId: z.string().uuid(),
  fileName: z.string().trim().min(1).max(200),
  text: z.string().min(1, "Choose a statement file.").max(MAX_CHARS, "This file is too large. Import one month or quarter at a time."),
  mapping: csvMappingSchema,
});

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export type StatementPreview = {
  fileAlreadyImported: boolean;
  totalLines: number;
  newLines: number;
  duplicateLines: number;
  beforeOpeningLines: number;
  problems: StatementProblem[];
  fromDate: string | null;
  toDate: string | null;
  sample: ParsedStatementLine[];
  /** First CSV rows, so the owner can pick columns by looking at the data. */
  rawSample: string[][];
};

function readFile(text: string, mapping: CsvMapping) {
  let rows: string[][];
  try {
    rows = parseCsv(text);
  } catch (error) {
    if (error instanceof CsvParseError) throw new ValidationError(`This file could not be read as a CSV: ${error.message}`);
    throw error;
  }
  if (rows.length === 0) throw new ValidationError("This file is empty.");
  const parsed = parseStatement(rows, mapping);
  if (parsed.lines.length > MAX_LINES) throw new ValidationError("This file has too many lines. Import one month or quarter at a time.");
  return { rows, ...parsed };
}

/** The same text imported twice must hash the same, whatever the line endings. */
const fileHashOf = (text: string) => hash(text.replace(/\r\n/g, "\n").trim());

async function classify(db: Db, shopId: string, bank: { id: string; openingAsOf: string }, lines: ParsedStatementLine[]) {
  const numbered = withOccurrences(lines).map((line) => ({ ...line, fingerprint: hash(line.key) }));
  const known = new Set<string>();
  const fingerprints = [...new Set(numbered.map((line) => line.fingerprint))];
  for (let i = 0; i < fingerprints.length; i += 1000) {
    const rows = await db
      .select({ fingerprint: bankStatementLines.fingerprint, occurrence: bankStatementLines.occurrence })
      .from(bankStatementLines)
      .where(and(eq(bankStatementLines.shopId, shopId), eq(bankStatementLines.bankAccountId, bank.id), inArray(bankStatementLines.fingerprint, fingerprints.slice(i, i + 1000))));
    for (const row of rows) known.add(`${row.fingerprint}#${row.occurrence}`);
  }
  const fresh = numbered.filter((line) => !known.has(`${line.fingerprint}#${line.occurrence}`));
  return { numbered, fresh, duplicateCount: numbered.length - fresh.length };
}

/** Checks the file and the mapping and shows what would be imported. Saves nothing. */
export async function previewStatement(session: SessionContext, input: unknown): Promise<StatementPreview> {
  await requirePermission(session, BANK_MANAGE);
  const data = importInputSchema.parse(input);
  const db = getDb();
  const bank = await loadBank(db, session.shopId, data.bankAccountId);
  const { rows, lines, problems } = readFile(data.text, data.mapping);
  const { fresh, duplicateCount } = await classify(db, session.shopId, bank, lines);
  const [existing] = await db.select({ id: bankStatements.id }).from(bankStatements).where(and(eq(bankStatements.bankAccountId, bank.id), eq(bankStatements.fileHash, fileHashOf(data.text)))).limit(1);
  const dates = lines.map((line) => line.txnDate).sort();
  return {
    fileAlreadyImported: Boolean(existing),
    totalLines: lines.length,
    newLines: fresh.length,
    duplicateLines: duplicateCount,
    beforeOpeningLines: fresh.filter((line) => line.txnDate <= bank.openingAsOf).length,
    problems: problems.slice(0, 20),
    fromDate: dates[0] ?? null,
    toDate: dates.at(-1) ?? null,
    sample: lines.slice(0, 6),
    rawSample: rows.slice(0, 6),
  };
}

export type ImportResult = { statementId: string; imported: number; duplicates: number };

/** Saves the statement's new lines. Refuses a file with unreadable rows (fix the file or the columns), and a file imported before. */
export async function importStatement(session: SessionContext, input: unknown): Promise<ImportResult> {
  await requirePermission(session, BANK_MANAGE);
  const data = importInputSchema.parse(input);
  return withTransaction(async (tx) => {
    await requireBooks(tx, session.shopId);
    // One import at a time per account, so two uploads cannot number the same identical lines twice.
    const bank = await loadBank(tx, session.shopId, data.bankAccountId, { lock: true });
    if (!bank.isActive) throw new ConflictError("BANK_OFF", "This bank account is switched off.");
    const { lines, problems } = readFile(data.text, data.mapping);
    if (problems.length > 0) throw new ValidationError(`Some rows in this file could not be read (row ${problems[0]!.row}: ${problems[0]!.message}) Check the columns, or fix the file.`);
    if (lines.length === 0) throw new ValidationError("This file has no transactions.");
    const fileHash = fileHashOf(data.text);
    const [already] = await tx.select({ id: bankStatements.id }).from(bankStatements).where(and(eq(bankStatements.bankAccountId, bank.id), eq(bankStatements.fileHash, fileHash))).limit(1);
    if (already) throw new ConflictError("STATEMENT_ALREADY_IMPORTED", "You have already imported this exact file.");
    const { fresh, duplicateCount } = await classify(tx, session.shopId, bank, lines);
    const dates = lines.map((line) => line.txnDate).sort();
    const [statement] = await tx
      .insert(bankStatements)
      .values({ shopId: session.shopId, bankAccountId: bank.id, fileName: data.fileName, fileHash, lineCount: lines.length, newLineCount: fresh.length, duplicateLineCount: duplicateCount, fromDate: dates[0]!, toDate: dates.at(-1)!, importedBy: session.userId })
      .returning({ id: bankStatements.id });
    for (let i = 0; i < fresh.length; i += 500) {
      await tx.insert(bankStatementLines).values(
        fresh.slice(i, i + 500).map((line) => ({
          shopId: session.shopId,
          statementId: statement!.id,
          bankAccountId: bank.id,
          txnDate: line.txnDate,
          narration: line.narration,
          reference: line.reference,
          debitPaise: line.debitPaise,
          creditPaise: line.creditPaise,
          balancePaise: line.balancePaise,
          fingerprint: line.fingerprint,
          occurrence: line.occurrence,
          // Lines from before the account was added are already inside its opening figure, so they are not asked about again.
          status: line.txnDate <= bank.openingAsOf ? ("ignored" as const) : ("unmatched" as const),
          ignoreReason: line.txnDate <= bank.openingAsOf ? "before_opening" : null,
        })),
      );
    }
    await saveCsvMapping(tx, session.shopId, bank.id, data.mapping);
    await recordAudit(tx, actorOf(session), { action: "bank.statement_imported", entityType: "bank_statement", entityId: statement!.id, after: { bankAccountId: bank.id, fileName: data.fileName, lines: lines.length, imported: fresh.length, duplicates: duplicateCount } });
    return { statementId: statement!.id, imported: fresh.length, duplicates: duplicateCount };
  });
}

export type StatementRow = { id: string; fileName: string; fromDate: string | null; toDate: string | null; lineCount: number; newLineCount: number; duplicateLineCount: number; createdAt: Date };

export async function listStatements(session: SessionContext, bankAccountId: string): Promise<StatementRow[]> {
  await requirePermission(session, BANK_MANAGE);
  const db = getDb();
  const bank = await loadBank(db, session.shopId, bankAccountId);
  const result = await db.execute<{ id: string; file_name: string; from_date: string | null; to_date: string | null; line_count: number; new_line_count: number; duplicate_line_count: number; created_at: Date }>(sql`
    select id, file_name, from_date::text, to_date::text, line_count, new_line_count, duplicate_line_count, created_at
    from bank_statements where shop_id = ${session.shopId} and bank_account_id = ${bank.id}::uuid order by created_at desc limit 50`);
  return result.rows.map((row) => ({ id: row.id, fileName: row.file_name, fromDate: row.from_date, toDate: row.to_date, lineCount: row.line_count, newLineCount: row.new_line_count, duplicateLineCount: row.duplicate_line_count, createdAt: row.created_at }));
}
