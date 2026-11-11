"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { LoaderCircle } from "lucide-react";
import { createPurchaseReturnAction } from "@/app/(app)/purchases/actions";
import { BankAccountPicker, chosenBank, type BankChoice } from "@/components/bank/bank-choice";
import { Field, FormAlert, selectClass } from "@/components/catalog/form-bits";
import { useT } from "@/components/nexora/language-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/nexora/money";

type Line = { receiptLineId: string; productName: string; unit: string; receivedQty: string; returnedQty: string; remainingQty: string; unitCostPaise: number };

/** Goods go back at the price and GST of the receipt line, in the unit they came in: the person only says how many and why. */
export function PurchaseReturnForm({ receiptId, lines, godowns, homeGodownId, canRefund, bankAccounts = [] }: { receiptId: string; bankAccounts?: BankChoice[]; lines: Line[]; godowns?: { id: string; name: string }[]; homeGodownId: string | null; canRefund: boolean }) {
  const t = useT();
  const router = useRouter();
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [settlement, setSettlement] = useState<"credit" | "refund">("credit");
  const [refundMethod, setRefundMethod] = useState("cash");
  const [bankPick, setBankPick] = useState("");
  const bankAccountId = settlement === "refund" && refundMethod === "bank" ? chosenBank(bankAccounts, bankPick) : "";
  const [godownId, setGodownId] = useState(homeGodownId ?? "");
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const picked = lines.filter((line) => (quantities[line.receiptLineId] ?? "").trim() !== "");
  const submit = () =>
    start(async () => {
      const result = await createPurchaseReturnAction({
        idempotencyKey,
        goodsReceiptId: receiptId,
        reason,
        settlement,
        ...(settlement === "refund" ? { refundMethod } : {}),
        ...(bankAccountId ? { bankAccountId } : {}),
        ...(godowns && godownId ? { godownId } : {}),
        lines: picked.map((line) => ({ receiptLineId: line.receiptLineId, quantity: quantities[line.receiptLineId]!.trim() })),
      });
      if (result.ok && result.id) {
        router.push(`/purchases/returns/${result.id}?new=1`);
        return;
      }
      setError(result.error);
      setFieldErrors(result.fieldErrors ?? {});
    });
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-3">
        {lines.map((line, index) => (
          <li key={line.receiptLineId} className="grid gap-3 rounded-xl border border-border p-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-1 text-sm">
              <span className="font-medium text-foreground">{line.productName}</span>
              <span className="text-xs text-muted-foreground">
                {t("purchases.return.received")}: {line.receivedQty} {line.unit} · {t("purchases.return.returned")}: {line.returnedQty} · {t("purchases.return.left")}: {line.remainingQty} {line.unit}
              </span>
              <span className="text-xs text-muted-foreground">
                <Money paise={line.unitCostPaise} withPaise />
              </span>
            </div>
            <Field label={`${t("purchases.return.qty")} (${line.unit})`} error={fieldErrors[`lines.${index}.quantity`]}>
              <Input value={quantities[line.receiptLineId] ?? ""} disabled={Number(line.remainingQty) <= 0} onChange={(event) => setQuantities((all) => ({ ...all, [line.receiptLineId]: event.target.value }))} inputMode="decimal" className="h-11 tabular-nums" />
            </Field>
          </li>
        ))}
      </ul>
      {godowns ? (
        <Field label={t("purchases.return.godown")} hint={t("purchases.return.godownHint")} error={fieldErrors.godownId}>
          <select value={godownId} onChange={(event) => setGodownId(event.target.value)} className={selectClass}>
            {godowns.map((godown) => (
              <option key={godown.id} value={godown.id}>
                {godown.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <Field label={t("purchases.return.reason")} error={fieldErrors.reason}>
        <Input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={200} className="h-11" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("purchases.return.settle")} error={fieldErrors.settlement}>
          <select value={settlement} onChange={(event) => setSettlement(event.target.value as "credit" | "refund")} className={selectClass}>
            <option value="credit">{t("purchases.return.credit")}</option>
            {canRefund ? <option value="refund">{t("purchases.return.refund")}</option> : null}
          </select>
        </Field>
        {settlement === "refund" ? (
          <Field label={t("purchases.return.refundHow")} error={fieldErrors.refundMethod}>
            <select value={refundMethod} onChange={(event) => setRefundMethod(event.target.value)} className={selectClass}>
              <option value="cash">{t("common.cash")}</option>
              <option value="upi">{t("common.upi")}</option>
              <option value="bank">{t("common.bank")}</option>
              <option value="cheque">{t("common.cheque")}</option>
            </select>
          </Field>
        ) : null}
        {bankAccountId ? <BankAccountPicker accounts={bankAccounts} value={bankAccountId} onChange={setBankPick} error={fieldErrors.bankAccountId} /> : null}
      </div>
      <FormAlert error={error} />
      <Button type="button" size="touch" className="self-start" disabled={pending || picked.length === 0} onClick={submit}>
        {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
        {t("purchases.return.save")}
      </Button>
    </div>
  );
}
