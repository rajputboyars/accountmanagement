"use client";

import { useActionState, useState } from "react";
import { valueStockAction, type MoneyResult } from "@/app/(app)/reports/money/actions";
import { Field, FormAlert, FormSelect, SubmitButton } from "@/components/catalog/form-bits";
import { useT } from "@/components/nexora/language-provider";
import { Input } from "@/components/ui/input";

/** One product's missing cost. The owner confirms part or all of the quantity, with a cost per unit or a total value and its source. */
export function FixRow({ gapId, name, sku, baseUnit, remaining }: { gapId: string; name: string; sku: string; baseUnit: string; remaining: string }) {
  const t = useT();
  const [key, setKey] = useState(() => crypto.randomUUID());
  // A new confirmation needs a new key; a retry of the same one must reuse it.
  const [state, action] = useActionState<MoneyResult, FormData>(async (previous, formData) => {
    const result = await valueStockAction(previous, formData);
    if (result.ok) setKey(crypto.randomUUID());
    return result;
  }, {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="gapId" value={gapId} />
      <input type="hidden" name="idempotencyKey" value={key} />
      <input type="hidden" name="unit" value={baseUnit} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("money.fix.quantity", { unit: baseUnit })} hint={t("money.fix.partial")} error={state.fieldErrors?.quantity}>
          <Input name="quantity" inputMode="decimal" defaultValue={remaining} aria-label={`${name} ${sku}`} className="h-11 tabular-nums" />
        </Field>
        <Field label={t("money.fix.amount")} error={state.fieldErrors?.amount}>
          <Input name="amount" inputMode="decimal" className="h-11 tabular-nums" />
        </Field>
        <Field label={t("money.fix.source")} hint={t("money.fix.sourceHint")} error={state.fieldErrors?.source} className="sm:col-span-2">
          <Input name="source" maxLength={200} className="h-11" />
        </Field>
        <FormSelect name="mode" defaultValue="unit" aria-label={t("money.fix.amount")}>
          <option value="unit">{t("money.fix.modeUnit", { unit: baseUnit })}</option>
          <option value="total">{t("money.fix.modeTotal")}</option>
        </FormSelect>
      </div>
      <FormAlert error={state.error} message={state.ok ? state.message : undefined} />
      <SubmitButton className="self-start">{t("money.fix.save")}</SubmitButton>
    </form>
  );
}
