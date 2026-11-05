"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { LoaderCircle } from "lucide-react";
import { importAction, previewImportAction, type BankResult } from "@/app/(app)/reports/money/bank/actions";
import { Field, FormAlert, selectClass } from "@/components/catalog/form-bits";
import { useLanguage, useT } from "@/components/nexora/language-provider";
import { Button } from "@/components/ui/button";
import { parseCsv } from "@/shared/csv-parse";
import { translateServerMessage } from "@/shared/i18n";

export type SavedMapping = { hasHeader?: boolean; dateFormat?: string; dateColumn?: number; narrationColumn?: number; debitColumn?: number; creditColumn?: number; balanceColumn?: number | null; referenceColumn?: number | null } | null;

const guess = (headers: string[], words: string[]) => {
  const index = headers.findIndex((header) => words.some((word) => header.toLowerCase().includes(word)));
  return index === -1 ? "" : String(index);
};

/**
 * Reading a bank statement: choose the file, say which column is what (remembered for this account), check it, then import.
 * Nothing is added to your books by importing; each line is sorted out afterwards, with your say-so.
 */
export function ImportForm({ bankAccountId, saved }: { bankAccountId: string; saved: SavedMapping }) {
  const t = useT();
  const language = useLanguage();
  const router = useRouter();
  const [fileName, setFileName] = useState("");
  const [text, setText] = useState("");
  const [hasHeader, setHasHeader] = useState(saved?.hasHeader ?? true);
  const [dateFormat, setDateFormat] = useState(saved?.dateFormat ?? "dmy");
  const [columns, setColumns] = useState<Record<string, string>>({
    dateColumn: saved?.dateColumn !== undefined ? String(saved.dateColumn) : "",
    narrationColumn: saved?.narrationColumn !== undefined ? String(saved.narrationColumn) : "",
    debitColumn: saved?.debitColumn !== undefined ? String(saved.debitColumn) : "",
    creditColumn: saved?.creditColumn !== undefined ? String(saved.creditColumn) : "",
    balanceColumn: saved?.balanceColumn !== undefined && saved.balanceColumn !== null ? String(saved.balanceColumn) : "",
    referenceColumn: saved?.referenceColumn !== undefined && saved.referenceColumn !== null ? String(saved.referenceColumn) : "",
  });
  const [result, setResult] = useState<BankResult | null>(null);
  const [pending, start] = useTransition();
  const [fileError, setFileError] = useState<string>();

  const rows = useMemo(() => {
    if (!text) return [] as string[][];
    try {
      return parseCsv(text).slice(0, 6);
    } catch {
      return [] as string[][];
    }
  }, [text]);
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const headers = rows[0] ?? [];

  const onFile = async (file: File | undefined) => {
    setResult(null);
    setFileError(undefined);
    if (!file) return;
    if (file.size > 900_000) {
      setFileError(t("bank.import.tooBig"));
      return;
    }
    const content = await file.text();
    setFileName(file.name);
    setText(content);
    let first: string[] = [];
    try {
      first = parseCsv(content)[0] ?? [];
    } catch {
      first = [];
    }
    // Fill in what the first row's headings suggest, unless this account already has columns saved.
    if (!saved) {
      setColumns({
        dateColumn: guess(first, ["date"]),
        narrationColumn: guess(first, ["narration", "description", "particular", "remarks", "details"]),
        debitColumn: guess(first, ["debit", "withdraw", "paid out", "dr"]),
        creditColumn: guess(first, ["credit", "deposit", "paid in", "cr"]),
        balanceColumn: guess(first, ["balance"]),
        referenceColumn: guess(first, ["ref", "chq", "cheque", "utr"]),
      });
    }
  };

  const ready = text && ["dateColumn", "narrationColumn", "debitColumn", "creditColumn"].every((name) => columns[name] !== "");
  const payload = () => ({
    bankAccountId,
    fileName,
    text,
    mapping: { hasHeader, dateFormat, dateColumn: columns.dateColumn, narrationColumn: columns.narrationColumn, debitColumn: columns.debitColumn, creditColumn: columns.creditColumn, balanceColumn: columns.balanceColumn, referenceColumn: columns.referenceColumn },
  });
  const check = () => start(async () => setResult(await previewImportAction(payload())));
  const save = () =>
    start(async () => {
      const outcome = await importAction(payload());
      setResult(outcome);
      if (outcome.ok) router.push(`/reports/money/bank/${bankAccountId}`);
    });

  const choose = (name: string, label: string, optional = false) => (
    <Field label={label} key={name}>
      <select className={selectClass} value={columns[name] ?? ""} onChange={(event) => { setColumns((all) => ({ ...all, [name]: event.target.value })); setResult(null); }}>
        <option value="">{optional ? t("bank.import.none") : t("bank.import.choose")}</option>
        {Array.from({ length: width }, (_, index) => (
          <option key={index} value={String(index)}>
            {t("bank.import.column", { number: index + 1 })}
            {hasHeader && headers[index] ? ` · ${headers[index]}` : ""}
          </option>
        ))}
      </select>
    </Field>
  );
  const preview = result?.preview;

  return (
    <div className="flex flex-col gap-4">
      <Field label={t("bank.import.file")} hint={t("bank.import.fileHint")} error={fileError}>
        <input type="file" accept=".csv,text/csv" onChange={(event) => void onFile(event.target.files?.[0])} className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-muted file:px-4 file:py-2.5 file:text-sm file:font-medium" />
      </Field>

      {text ? (
        <>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[32rem] text-xs">
              <tbody className="divide-y divide-border">
                {rows.map((row, index) => (
                  <tr key={index} className={index === 0 && hasHeader ? "bg-muted/50 font-medium" : ""}>
                    {Array.from({ length: width }, (_, cell) => (
                      <td key={cell} className="max-w-48 truncate px-3 py-1.5">
                        {row[cell] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" className="size-4 accent-primary" checked={hasHeader} onChange={(event) => { setHasHeader(event.target.checked); setResult(null); }} />
            {t("bank.import.hasHeader")}
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            {choose("dateColumn", t("bank.import.date"))}
            <Field label={t("bank.import.dateFormat")}>
              <select className={selectClass} value={dateFormat} onChange={(event) => { setDateFormat(event.target.value); setResult(null); }}>
                <option value="dmy">{t("bank.import.dmy")}</option>
                <option value="mdy">{t("bank.import.mdy")}</option>
                <option value="ymd">{t("bank.import.ymd")}</option>
              </select>
            </Field>
            {choose("narrationColumn", t("bank.import.narration"))}
            {choose("debitColumn", t("bank.import.debit"))}
            {choose("creditColumn", t("bank.import.credit"))}
            {choose("balanceColumn", t("bank.import.balance"), true)}
            {choose("referenceColumn", t("bank.import.reference"), true)}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="touch" variant="outline" disabled={pending || !ready} onClick={check}>
              {pending && !preview ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
              {t("bank.import.check")}
            </Button>
          </div>
        </>
      ) : null}

      <FormAlert error={result?.error} message={result?.ok && !preview ? result.message : undefined} />

      {preview ? (
        <div className="flex flex-col gap-3 rounded-xl border border-border p-4 text-sm">
          <p className="font-medium text-foreground">{t("bank.import.found", { total: preview.totalLines, from: preview.fromDate ?? "", to: preview.toDate ?? "" })}</p>
          <ul className="flex flex-col gap-1 text-muted-foreground">
            <li>{t("bank.import.new", { count: preview.newLines })}</li>
            {preview.duplicateLines > 0 ? <li>{t("bank.import.duplicates", { count: preview.duplicateLines })}</li> : null}
            {preview.beforeOpeningLines > 0 ? <li>{t("bank.import.beforeOpening", { count: preview.beforeOpeningLines })}</li> : null}
          </ul>
          {preview.fileAlreadyImported ? <FormAlert error={t("bank.import.already")} /> : null}
          {preview.problems.length > 0 ? (
            <div className="flex flex-col gap-1 rounded-lg bg-danger-soft p-3 text-danger">
              <p className="font-medium">{t("bank.import.problems")}</p>
              <ul className="list-disc pl-5 text-xs">
                {preview.problems.map((problem) => (
                  <li key={problem.row}>{t("bank.import.problemRow", { row: problem.row, message: translateServerMessage(problem.message, language) })}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">{t("bank.import.safe")}</p>
          <Button type="button" size="touch" className="self-start" disabled={pending || preview.problems.length > 0 || preview.fileAlreadyImported || preview.newLines + preview.duplicateLines === 0} onClick={save}>
            {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
            {t("bank.import.submit", { count: preview.newLines })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
