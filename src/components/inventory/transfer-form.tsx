"use client";

import { useActionState, useState } from "react";
import { Plus, X } from "lucide-react";
import { transferStockAction, type TransferFormState } from "@/app/(app)/inventory/stock/actions";
import { Field, FormAlert, selectClass } from "@/components/catalog/form-bits";
import { useT } from "@/components/nexora/language-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { TransferOptions } from "@/modules/inventory";

type Line = { key: number; productId: string; unit: string; quantity: string };
let nextKey = 1;
const blank = (): Line => ({ key: nextKey++, productId: "", unit: "", quantity: "" });

/** Move stock from one godown to another: pick the two godowns, then products and quantities in any of their units. */
export function TransferForm({ options }: { options: TransferOptions }) {
  const t = useT();
  const [from, setFrom] = useState(options.godowns.find((godown) => godown.isDefault)?.id ?? options.godowns[0]?.id ?? "");
  const [to, setTo] = useState("");
  const [lines, setLines] = useState<Line[]>(() => [blank()]);
  const [note, setNote] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [state, action, pending] = useActionState<TransferFormState, FormData>(async (previous, formData) => {
    const result = await transferStockAction(previous, formData);
    if (result.number) {
      setLines([blank()]);
      setNote("");
      setIdempotencyKey(crypto.randomUUID());
    }
    return result;
  }, {});
  const productsHere = options.products.filter((product) => Number(product.qtyByGodown[from] ?? 0) > 0);
  const update = (key: number, changes: Partial<Line>) => setLines((all) => all.map((line) => (line.key === key ? { ...line, ...changes } : line)));
  const payload = JSON.stringify({
    idempotencyKey,
    fromGodownId: from,
    toGodownId: to,
    reason: note,
    lines: lines.filter((line) => line.productId).map((line) => ({ productId: line.productId, unit: line.unit || options.products.find((product) => product.id === line.productId)?.baseUnit || "", quantity: line.quantity })),
  });
  const errors = state.fieldErrors ?? {};
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="payload" value={payload} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("godown.transfer.from")} error={errors.fromGodownId}>
          <select value={from} onChange={(event) => setFrom(event.target.value)} className={selectClass}>
            {options.godowns.map((godown) => (
              <option key={godown.id} value={godown.id}>
                {godown.isDefault && godown.name === "Main Store" ? t("godown.mainStore") : godown.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("godown.transfer.to")} error={errors.toGodownId}>
          <select value={to} onChange={(event) => setTo(event.target.value)} className={selectClass}>
            <option value="">{t("godown.choose")}</option>
            {options.godowns
              .filter((godown) => godown.id !== from)
              .map((godown) => (
                <option key={godown.id} value={godown.id}>
                  {godown.isDefault && godown.name === "Main Store" ? t("godown.mainStore") : godown.name}
                </option>
              ))}
          </select>
        </Field>
      </div>
      <ul className="flex flex-col gap-3">
        {lines.map((line, index) => {
          const product = options.products.find((candidate) => candidate.id === line.productId);
          return (
            <li key={line.key} className="grid gap-3 rounded-xl border border-border p-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
              <Field label={t("godown.transfer.product")} error={errors[`lines.${index}.productId`]}>
                <select value={line.productId} onChange={(event) => update(line.key, { productId: event.target.value, unit: "" })} className={selectClass}>
                  <option value="">{t("common.choose")}</option>
                  {productsHere.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name} ({candidate.sku}) · {Number(candidate.qtyByGodown[from] ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })} {candidate.baseUnit}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("godown.transfer.qty")} error={errors[`lines.${index}.quantity`]}>
                <Input value={line.quantity} onChange={(event) => update(line.key, { quantity: event.target.value })} inputMode="decimal" className="h-11 tabular-nums" />
              </Field>
              <Field label={t("godown.transfer.unit")} error={errors[`lines.${index}.unit`]}>
                <select value={line.unit || product?.baseUnit || ""} onChange={(event) => update(line.key, { unit: event.target.value })} className={selectClass} disabled={!product}>
                  {(product?.units ?? []).map((unit) => (
                    <option key={unit.code} value={unit.code}>
                      {unit.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Button type="button" variant="ghost" size="icon" className="size-11 self-end" aria-label={t("godown.transfer.remove")} onClick={() => setLines((all) => (all.length > 1 ? all.filter((candidate) => candidate.key !== line.key) : [blank()]))}>
                <X aria-hidden="true" />
              </Button>
            </li>
          );
        })}
      </ul>
      <Button type="button" variant="outline" size="touch" className="self-start" onClick={() => setLines((all) => [...all, blank()])}>
        <Plus aria-hidden="true" />
        {t("godown.transfer.addLine")}
      </Button>
      <Field label={t("godown.transfer.note")}>
        <Input value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} className="h-11" />
      </Field>
      <FormAlert error={state.error} message={state.number ? t("godown.transfer.done", { number: state.number }) : undefined} />
      <Button type="submit" size="touch" className="self-start" disabled={pending || !to}>
        {t("godown.transfer.save")}
      </Button>
    </form>
  );
}
