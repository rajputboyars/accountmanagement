"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { LoaderCircle } from "lucide-react";
import { ignoreLineAction, matchAction, postLineAction, restoreLineAction, undoAction, type BankResult } from "@/app/(app)/reports/money/bank/actions";
import { Field, FormAlert, selectClass } from "@/components/catalog/form-bits";
import { useLanguage, useT } from "@/components/nexora/language-provider";
import { Money } from "@/components/nexora/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { billDate } from "@/shared/i18n/labels";
import { formatPaise } from "@/shared/money";

export type BankLine = {
  id: string;
  txnDate: string;
  narration: string;
  reference: string | null;
  debitPaise: number;
  creditPaise: number;
  status: string;
  ignoreReason: string | null;
  group: { id: string; kind: string; postingKind: string | null; feePaise: number; undoable: boolean } | null;
};
export type BankItem = { journalLineId: number; signedPaise: number; date: string; label: string; partyName: string | null; reference: string | null; method: string | null; clearing: boolean };
export type BankSuggestion = { lineId: string; kind: "match" | "settlement"; itemIds: string[]; feePaise: number; grossPaise: number };
type Party = { id: string; name: string };

const rs = (paise: number) => formatPaise(paise, { withPaise: true });
const CREDIT_KINDS = ["customer_receipt", "bank_interest", "owner_in"] as const;
const DEBIT_KINDS = ["supplier_payment", "bank_charge", "owner_out"] as const;
const itemLabelKey = (label: string) => (label === "payment" || label === "reversal" || label === "cash_movement" || label === "expense" ? (`bank.item.${label}` as const) : ("bank.item.other" as const));

function Amount({ line }: { line: { debitPaise: number; creditPaise: number } }) {
  const credit = line.creditPaise > 0;
  return (
    <span className={credit ? "font-semibold text-success tabular-nums" : "font-semibold text-foreground tabular-nums"}>
      {credit ? "+" : "−"}
      <Money paise={credit ? line.creditPaise : line.debitPaise} withPaise />
    </span>
  );
}

/** Runs a bank action once, keeping the same key if the owner taps again, then refreshes the page. */
function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<BankResult | null>(null);
  const run = (work: () => Promise<BankResult>) =>
    start(async () => {
      const outcome = await work();
      setResult(outcome);
      if (outcome.ok) router.refresh();
    });
  return { pending, result, run };
}

function ItemText({ item }: { item: BankItem }) {
  const t = useT();
  const language = useLanguage();
  return (
    <span className="min-w-0 text-sm">
      <span className="font-medium text-foreground">{item.partyName ?? t(itemLabelKey(item.label))}</span>
      <span className="block text-xs text-muted-foreground">
        {billDate(item.date, language)}
        {item.method ? ` · ${t(`common.${item.method === "cheque" ? "cheque" : item.method}` as never)}` : ""}
        {item.reference ? ` · ${item.reference}` : ""}
      </span>
    </span>
  );
}

function LineCard({ bankAccountId, line, suggestion, items, customers, suppliers, locked }: { bankAccountId: string; line: BankLine; suggestion?: BankSuggestion; items: BankItem[]; customers: Party[]; suppliers: Party[]; locked: boolean }) {
  const t = useT();
  const language = useLanguage();
  const { pending, result, run } = useRun();
  const key = useRef(crypto.randomUUID());
  const [mode, setMode] = useState<null | "match" | "post" | "ignore">(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [kind, setKind] = useState("");
  const [partyId, setPartyId] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState("");
  const credit = line.creditPaise > 0;
  const amount = credit ? line.creditPaise : line.debitPaise;
  const signed = credit ? amount : -amount;
  const offered = items.filter((item) => Math.sign(item.signedPaise) === Math.sign(signed));
  const pickedItems = offered.filter((item) => picked.includes(item.journalLineId));
  const pickedTotal = pickedItems.reduce((sum, item) => sum + item.signedPaise, 0);
  const pickedClearing = pickedItems.some((item) => item.clearing);
  const diff = pickedTotal - signed;
  const mixed = pickedClearing && pickedItems.some((item) => !item.clearing);
  const kinds = credit ? CREDIT_KINDS : DEBIT_KINDS;
  const needsParty = kind === "customer_receipt" || kind === "supplier_payment";
  const parties = kind === "customer_receipt" ? customers : suppliers;
  const suggested = suggestion ? items.filter((item) => suggestion.itemIds.includes(String(item.journalLineId))) : [];

  const doMatch = (ids: number[], confirmLargeFee?: boolean) => run(() => matchAction({ idempotencyKey: key.current, bankAccountId, lineIds: [line.id], itemIds: ids, confirmLargeFee }));
  const feeLarge = result?.code === "FEE_LARGE";

  if (line.status !== "unmatched") {
    return (
      <li className="flex flex-col gap-2 rounded-xl border border-border p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="min-w-0">
            <span className="font-medium text-foreground">{line.narration || "—"}</span>
            <span className="block text-xs text-muted-foreground">{billDate(line.txnDate, language)}{line.reference ? ` · ${line.reference}` : ""}</span>
          </span>
          <span className="flex items-center gap-2">
            <Amount line={line} />
            <Badge variant={line.status === "matched" ? "success" : "neutral"}>
              {line.group ? t(`bank.status.${line.group.kind === "posting" ? "posted" : line.group.kind === "settlement" ? "settled" : "matched"}`) : t("bank.status.ignored")}
            </Badge>
          </span>
        </div>
        {line.status === "ignored" && line.ignoreReason ? <p className="text-xs text-muted-foreground">{t("bank.leftOutBecause", { reason: line.ignoreReason })}</p> : null}
        {line.group?.feePaise ? <p className="text-xs text-muted-foreground">{t("bank.feeKept", { amount: rs(line.group.feePaise) })}</p> : null}
        {!locked && line.group?.undoable ? (
          <details className="text-xs">
            <summary className="cursor-pointer font-medium text-teal-strong">{t("bank.undo")}</summary>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <Field label={t("bank.undoReason")} className="min-w-48 flex-1">
                <Input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={200} className="h-10" />
              </Field>
              <Button type="button" variant="outline" disabled={pending || reason.trim().length < 3} onClick={() => run(() => undoAction(bankAccountId, line.group!.id, reason, key.current))}>
                {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
                {t("bank.undoConfirm")}
              </Button>
            </div>
          </details>
        ) : null}
        {!locked && line.status === "ignored" && line.ignoreReason !== "before_opening" ? (
          <Button type="button" variant="outline" size="sm" className="self-start" disabled={pending} onClick={() => run(() => restoreLineAction(bankAccountId, line.id))}>
            {t("bank.restore")}
          </Button>
        ) : null}
        <FormAlert error={result?.error} />
      </li>
    );
  }

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="font-medium break-words text-foreground">{line.narration || "—"}</span>
          <span className="block text-xs text-muted-foreground">{billDate(line.txnDate, language)}{line.reference ? ` · ${line.reference}` : ""}</span>
        </span>
        <Amount line={line} />
      </div>

      {suggestion ? (
        <div className="flex flex-col gap-2 rounded-lg bg-teal-soft p-3">
          <p className="font-medium text-foreground">{suggestion.kind === "settlement" ? t("bank.suggest.settle", { count: suggested.length, gross: rs(Math.abs(suggestion.grossPaise)) }) : t("bank.suggest.match")}</p>
          <ul className="flex flex-col gap-1">
            {suggested.map((item) => (
              <li key={item.journalLineId} className="flex items-center justify-between gap-2">
                <ItemText item={item} />
                <span className="tabular-nums">
                  <Money paise={Math.abs(item.signedPaise)} withPaise />
                </span>
              </li>
            ))}
          </ul>
          {suggestion.kind === "settlement" && suggestion.feePaise > 0 ? (
            <p className="text-xs text-muted-foreground">{t("bank.suggest.fee", { amount: rs(suggestion.feePaise) })}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="touch" disabled={pending || locked} onClick={() => doMatch(suggested.map((item) => item.journalLineId), feeLarge)}>
              {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
              {feeLarge ? t("bank.suggest.confirmFee") : suggestion.kind === "settlement" ? t("bank.suggest.yesSettle") : t("bank.suggest.yesMatch")}
            </Button>
          </div>
        </div>
      ) : null}
      <FormAlert error={result?.error} message={result?.ok ? result.message : undefined} />

      {!locked ? (
        <div className="flex flex-wrap gap-2">
          {(["match", "post", "ignore"] as const).map((option) => (
            <Button key={option} type="button" variant={mode === option ? "default" : "outline"} size="sm" onClick={() => setMode(mode === option ? null : option)}>
              {t(`bank.option.${option}`)}
            </Button>
          ))}
        </div>
      ) : null}

      {mode === "match" ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">{t("bank.match.help")}</p>
          {offered.length === 0 ? <p className="text-sm text-muted-foreground">{t("bank.match.none")}</p> : null}
          <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
            {offered.map((item) => (
              <li key={item.journalLineId}>
                <label className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-muted/50">
                  <input type="checkbox" className="size-4 accent-primary" checked={picked.includes(item.journalLineId)} onChange={(event) => setPicked((all) => (event.target.checked ? [...all, item.journalLineId] : all.filter((id) => id !== item.journalLineId)))} />
                  <ItemText item={item} />
                  <span className="ml-auto flex flex-col items-end tabular-nums">
                    <Money paise={Math.abs(item.signedPaise)} withPaise />
                    {item.clearing ? <span className="text-xs text-muted-foreground">{t("bank.match.notInBank")}</span> : null}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {picked.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {mixed ? t("bank.match.mixed") : pickedClearing ? (diff >= 0 ? t("bank.match.feeIs", { amount: rs(Math.abs(diff)) }) : t("bank.match.tooLittle")) : diff === 0 ? t("bank.match.exact") : t("bank.match.differs", { amount: rs(Math.abs(diff)) })}
            </p>
          ) : null}
          <Button type="button" size="touch" className="self-start" disabled={pending || picked.length === 0 || mixed || (pickedClearing ? diff < 0 : diff !== 0)} onClick={() => doMatch(picked, feeLarge)}>
            {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
            {feeLarge ? t("bank.suggest.confirmFee") : pickedClearing ? t("bank.suggest.yesSettle") : t("bank.suggest.yesMatch")}
          </Button>
        </div>
      ) : null}

      {mode === "post" ? (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">{t("bank.post.help")}</p>
          <Field label={t("bank.post.what")}>
            <select className={selectClass} value={kind} onChange={(event) => { setKind(event.target.value); setPartyId(""); }}>
              <option value="">{t("bank.post.choose")}</option>
              {kinds.map((option) => (
                <option key={option} value={option}>
                  {t(`bank.post.kind.${option}`)}
                </option>
              ))}
            </select>
          </Field>
          {needsParty ? (
            <Field label={kind === "customer_receipt" ? t("bank.post.customer") : t("bank.post.supplier")}>
              <select className={selectClass} value={partyId} onChange={(event) => setPartyId(event.target.value)}>
                <option value="">{t("bank.post.choose")}</option>
                {parties.map((party) => (
                  <option key={party.id} value={party.id}>
                    {party.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          {kind ? <p className="rounded-lg bg-muted/50 p-3 text-xs text-foreground">{t(`bank.post.effect.${kind}` as never, { amount: rs(amount) })}</p> : null}
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input type="checkbox" className="mt-1 size-4 accent-primary" checked={confirm} onChange={(event) => setConfirm(event.target.checked)} />
            {t("bank.post.confirm")}
          </label>
          <Button type="button" size="touch" className="self-start" disabled={pending || !kind || !confirm || (needsParty && !partyId)} onClick={() => run(() => postLineAction({ idempotencyKey: key.current, bankAccountId, lineId: line.id, kind, partyId: partyId || undefined, confirm: true }))}>
            {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
            {t("bank.post.submit")}
          </Button>
        </div>
      ) : null}

      {mode === "ignore" ? (
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t("bank.ignore.reason")} hint={t("bank.ignore.hint")} className="min-w-48 flex-1">
            <Input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={200} className="h-10" />
          </Field>
          <Button type="button" variant="outline" size="touch" disabled={pending || reason.trim().length < 3} onClick={() => run(() => ignoreLineAction(bankAccountId, line.id, reason))}>
            {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
            {t("bank.ignore.submit")}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** The statement lines still to sort out (or all of them), each with a suggestion when there is one and three clear ways to deal with it. */
export function BankLines({ bankAccountId, lines, items, suggestions, customers, suppliers, finalizedThrough }: { bankAccountId: string; lines: BankLine[]; items: BankItem[]; suggestions: BankSuggestion[]; customers: Party[]; suppliers: Party[]; finalizedThrough: string | null }) {
  return (
    <ul className="flex flex-col gap-3">
      {lines.map((line) => (
        <LineCard key={line.id} bankAccountId={bankAccountId} line={line} suggestion={suggestions.find((candidate) => candidate.lineId === line.id)} items={items} customers={customers} suppliers={suppliers} locked={Boolean(finalizedThrough && line.txnDate <= finalizedThrough)} />
      ))}
    </ul>
  );
}
