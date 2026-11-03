"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";
import { LoaderCircle, Search } from "lucide-react";
import { findInvoiceAction, previewReturnAction, saveReturnAction, type ReturnPayload } from "@/app/(app)/billing/returns/actions";
import { Field, FormAlert, SubmitButton, selectClass } from "@/components/catalog/form-bits";
import { useT } from "@/components/nexora/language-provider";
import { Money } from "@/components/nexora/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ReturnPreview } from "@/modules/sales";

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "") : `${Date.now()}${Math.random().toString(36).slice(2)}`);

export function FindInvoiceForm() {
  const t = useT();
  const [state, action] = useActionState(findInvoiceAction, {});
  return (
    <form action={action} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <Field label={t("returns.billNumber")} hint={t("returns.billNumberHint")} error={state.error} className="flex-1">
        <Input name="number" placeholder={t("returns.billNumberPlaceholder")} className="h-11" autoComplete="off" />
      </Field>
      <SubmitButton>
        <Search aria-hidden="true" />
        {t("returns.findBillButton")}
      </SubmitButton>
    </form>
  );
}

type Line = { id: string; lineNo: number; productName: string; baseUnit: string; sold: string; soldBaseQty: string; returnedBaseQty: string; remainingBaseQty: string };

export function ReturnForm({ invoice }: { invoice: { id: string; number: string; customer: { name: string; type: string }; lines: Line[] } }) {
  const router = useRouter();
  const t = useT();
  const walkIn = invoice.customer.type === "walkin";
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [restock, setRestock] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState("");
  const [settlement, setSettlement] = useState(walkIn ? "cash" : "ledger");
  const [preview, setPreview] = useState<ReturnPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [idempotencyKey] = useState(newKey);
  const [pending, startTransition] = useTransition();

  const chosen = invoice.lines.filter((line) => (quantities[line.id] ?? "").trim() !== "");
  const payload: ReturnPayload = { invoiceId: invoice.id, lines: chosen.map((line) => ({ invoiceLineId: line.id, baseQty: quantities[line.id]!.trim(), restock: restock[line.id] ?? true })), reason, settlement };
  const lineError = (lineId: string) => {
    const index = chosen.findIndex((line) => line.id === lineId);
    return index >= 0 ? fieldErrors[`lines.${index}.baseQty`] : undefined;
  };

  const review = () =>
    startTransition(async () => {
      const result = await previewReturnAction(payload);
      setPreview(result.preview ?? null);
      setError(result.preview ? null : (result.error ?? t("returns.errorWorkingOut")));
      setFieldErrors(result.fieldErrors ?? {});
    });

  const confirm = () =>
    startTransition(async () => {
      if (!preview) return;
      const result = await saveReturnAction({ ...payload, idempotencyKey, expectedTotalPaise: preview.totalPaise });
      if (result.creditNoteId) {
        router.push(`/billing/returns/${result.creditNoteId}?new=1`);
        return;
      }
      // Something changed (another return, for example): show the server's new figures, or go back to editing.
      setPreview(result.preview ?? null);
      setError(result.error ?? t("returns.errorNotSaved"));
      setFieldErrors(result.fieldErrors ?? {});
    });

  const editing = !preview;

  return (
    <div className="flex flex-col gap-5">
      <ul className="flex flex-col divide-y divide-border">
        {invoice.lines.map((line) => {
          const none = line.remainingBaseQty === "0";
          return (
            <li key={line.id} className="grid gap-3 py-3 first:pt-0 sm:grid-cols-[minmax(0,1fr)_9rem_12rem] sm:items-start">
              <div className="min-w-0">
                <p className="font-semibold text-foreground">
                  {line.lineNo}. {line.productName}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("returns.sold", { qty: line.sold })}
                  {line.sold !== `${line.soldBaseQty} ${line.baseUnit}` ? ` ${t("returns.soldBase", { qty: line.soldBaseQty, unit: line.baseUnit })}` : ""} · {t("returns.alreadyLeft", { returned: line.returnedBaseQty, left: line.remainingBaseQty, unit: line.baseUnit })}
                </p>
              </div>
              <Field label={t("returns.returnQty", { unit: line.baseUnit })} error={lineError(line.id)}>
                <Input
                  value={quantities[line.id] ?? ""}
                  onChange={(event) => setQuantities((all) => ({ ...all, [line.id]: event.target.value }))}
                  inputMode="decimal"
                  placeholder={none ? t("returns.noneLeft") : "0"}
                  disabled={none || !editing}
                  className="h-11 tabular-nums"
                />
              </Field>
              <label className="flex min-h-11 items-center gap-2 pt-0 text-sm text-foreground sm:pt-6">
                <input type="checkbox" checked={restock[line.id] ?? true} onChange={(event) => setRestock((all) => ({ ...all, [line.id]: event.target.checked }))} disabled={none || !editing} className="size-5 accent-[var(--teal-strong)]" />
                {t("returns.canResell")}
              </label>
            </li>
          );
        })}
      </ul>
      <p className="-mt-2 text-xs text-muted-foreground">{t("returns.damagedHelp")}</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("common.reason")} error={fieldErrors.reason}>
          <Input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={200} placeholder={t("returns.reasonPlaceholder")} disabled={!editing} className="h-11" />
        </Field>
        <Field help="refundVsReversal" label={t("returns.settleBy")} hint={t(walkIn ? "returns.settleWalkIn" : "returns.settleAccount")} error={fieldErrors.settlement}>
          <select value={settlement} onChange={(event) => setSettlement(event.target.value)} disabled={!editing} className={selectClass}>
            {!walkIn ? <option value="ledger">{t("returns.reduceOutstanding")}</option> : null}
            <option value="cash">{t("returns.cashRefund")}</option>
            <option value="upi">{t("returns.upiRefund")}</option>
            <option value="bank">{t("returns.bankRefund")}</option>
          </select>
        </Field>
      </div>

      <FormAlert error={error ?? undefined} />

      {preview ? (
        <section aria-label={t("returns.review")} className="flex flex-col gap-3 rounded-2xl bg-amber-soft p-4 text-sm text-amber-ink">
          <p className="font-semibold">{t("returns.reviewWarning")}</p>
          <ul className="flex flex-col gap-1">
            {preview.lines.map((line) => (
              <li key={line.invoiceLineId} className="flex justify-between gap-3">
                <span>
                  {t(line.restock ? "returns.lineRestock" : "returns.lineDamaged", { name: line.productName, qty: line.baseQty, unit: line.baseUnit })}
                </span>
                <Money paise={line.taxablePaise} withPaise />
              </li>
            ))}
          </ul>
          <dl className="flex flex-col gap-1 border-t border-amber/30 pt-2">
            <Row label={t("common.taxableValue")} paise={preview.taxablePaise} />
            <Row label="CGST" paise={preview.cgstPaise} />
            <Row label="SGST" paise={preview.sgstPaise} />
            {preview.roundOffPaise !== 0 ? <Row label={t("common.roundOff")} paise={preview.roundOffPaise} /> : null}
            <div className="flex justify-between gap-3 text-base font-bold">
              <dt>{t("returns.noteTotal")}</dt>
              <dd>
                <Money paise={preview.totalPaise} withPaise />
              </dd>
            </div>
          </dl>
          <p>{settlement === "ledger" ? t("returns.effectLedger", { name: invoice.customer.name }) : t(settlement === "cash" ? "returns.effectCash" : settlement === "upi" ? "returns.effectUpi" : "returns.effectBank")}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="touch" onClick={confirm} disabled={pending}>
              {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
              {t("returns.saveNote")}
            </Button>
            <Button type="button" variant="ghost" size="touch" onClick={() => setPreview(null)} disabled={pending}>
              {t("returns.goBack")}
            </Button>
          </div>
        </section>
      ) : (
        <Button type="button" size="touch" className="self-start" onClick={review} disabled={pending || chosen.length === 0}>
          {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
          {t("returns.reviewButton")}
        </Button>
      )}
    </div>
  );
}

function Row({ label, paise }: { label: string; paise: number }) {
  return (
    <div className="flex justify-between gap-3">
      <dt>{label}</dt>
      <dd>
        <Money paise={paise} withPaise />
      </dd>
    </div>
  );
}
