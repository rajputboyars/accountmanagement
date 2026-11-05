"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { LoaderCircle } from "lucide-react";
import { previewBillAction, saveBillAction, type BillInputPayload } from "@/app/(app)/billing/actions";
import { Field, FormAlert } from "@/components/catalog/form-bits";
import { useT } from "@/components/nexora/language-provider";
import { Money } from "@/components/nexora/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatPaise } from "@/shared/money";
import type { BillView } from "@/modules/sales";

type Billable = { challanLineId: string; productId: string; challanNumber: string; productName: string; unit: string; deliveredQty: string; billedQty: string; remainingQty: string; indicativeRatePaise: number };
const METHODS = ["cash", "upi", "card", "bank"] as const;

/**
 * Bill goods that were already delivered. Stock is not touched (it left on the challan); prices are worked out afresh by the server
 * and shown next to the order's price. Several partial bills can be made from the same delivery.
 */
export function ChallanBillForm({ customerId, lines }: { customerId: string; lines: Billable[] }) {
  const t = useT();
  const router = useRouter();
  const [quantities, setQuantities] = useState<Record<string, string>>(() => Object.fromEntries(lines.map((line) => [line.challanLineId, line.remainingQty])));
  const [payments, setPayments] = useState({ cash: "", upi: "", card: "", bank: "" });
  const [bill, setBill] = useState<BillView | null>(null);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string>();
  const [saving, startSave] = useTransition();
  const picked = lines.filter((line) => Number(quantities[line.challanLineId] ?? 0) > 0);
  const payload: BillInputPayload = {
    customerId,
    priceList: "",
    discountPercent: "",
    lines: picked.map((line) => ({ productId: line.productId, unit: line.unit, quantity: quantities[line.challanLineId]! })),
    payments,
    cashReceived: "",
    challanLines: picked.map((line) => ({ challanLineId: line.challanLineId, quantity: quantities[line.challanLineId]!.trim() })),
  };
  const key = JSON.stringify(payload);
  useEffect(() => {
    if (picked.length === 0) return;
    const timer = setTimeout(async () => {
      const result = await previewBillAction(JSON.parse(key) as BillInputPayload);
      setBill(result.bill ?? null);
      setError(result.bill ? undefined : result.error);
    }, 300);
    return () => clearTimeout(timer);
  }, [key, picked.length]);

  const diff = (line: Billable, rate: number | undefined) => {
    if (rate === undefined) return null;
    const delta = rate - line.indicativeRatePaise;
    if (delta === 0) return t("orders.bill.same");
    return t(delta > 0 ? "orders.bill.higher" : "orders.bill.lower", { amount: formatPaise(Math.abs(delta), { withPaise: true }) });
  };
  const save = () =>
    startSave(async () => {
      if (!bill) return;
      const result = await saveBillAction({ ...payload, idempotencyKey, expectedTotalPaise: bill.totals.totalPaise, expectedRates: bill.expectedRates });
      if (result.invoiceId) {
        router.push(`/billing/invoices/${result.invoiceId}`);
        return;
      }
      setError(result.error);
      if (result.bill) setBill(result.bill);
    });
  const problems = bill?.problems ?? [];
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-3">
        {lines.map((line, index) => {
          const shown = bill?.lines[picked.findIndex((candidate) => candidate.challanLineId === line.challanLineId)];
          return (
            <li key={line.challanLineId} className="grid gap-3 rounded-xl border border-border p-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <div className="flex min-w-0 flex-col gap-0.5 text-sm">
                <span className="font-medium text-foreground">{line.productName}</span>
                <span className="text-xs text-muted-foreground">
                  {line.challanNumber} · {t("orders.bill.delivered")}: {line.deliveredQty} {line.unit} · {t("orders.bill.billed")}: {line.billedQty}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t("orders.bill.orderRate")}: <Money paise={line.indicativeRatePaise} withPaise />
                  {shown ? (
                    <>
                      {" · "}
                      {t("orders.bill.billRate")}: <Money paise={shown.ratePaise} withPaise /> · {diff(line, shown.ratePaise)}
                    </>
                  ) : null}
                </span>
              </div>
              <Field label={`${t("orders.bill.now")} (${line.unit})`} error={problems.find((problem) => problem.field === `lines.${index}.quantity`)?.message}>
                <Input value={quantities[line.challanLineId] ?? ""} onChange={(event) => setQuantities((all) => ({ ...all, [line.challanLineId]: event.target.value }))} inputMode="decimal" className="h-11 tabular-nums" />
              </Field>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium text-foreground">{t("orders.bill.pay")}</p>
        <div className="grid gap-3 sm:grid-cols-4">
          {METHODS.map((method) => (
            <Field key={method} label={t(`common.${method}`)}>
              <Input value={payments[method]} onChange={(event) => setPayments((all) => ({ ...all, [method]: event.target.value }))} inputMode="decimal" placeholder="0" className="h-11 tabular-nums" />
            </Field>
          ))}
        </div>
      </div>
      {bill ? (
        <div className="flex flex-col gap-1 rounded-xl bg-muted/40 p-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("common.total")}</span>
            <span className="text-lg font-semibold">
              <Money paise={bill.totals.totalPaise} withPaise />
            </span>
          </div>
        </div>
      ) : null}
      {problems.length > 0 ? <FormAlert error={problems[0]!.message} /> : null}
      <FormAlert error={error} />
      <Button type="button" size="touch" className="self-start" disabled={saving || !bill || problems.length > 0 || picked.length === 0} onClick={save}>
        {saving ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
        {t("orders.bill.save")}
      </Button>
    </div>
  );
}
