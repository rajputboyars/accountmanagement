"use client";

import { useActionState, useState } from "react";
import { rebuildCacheAction, recordAdjustmentAction, type AdjustmentFormState } from "@/app/(app)/inventory/stock/actions";
import { Field, FormAlert, FormSelect, SubmitButton } from "@/components/catalog/form-bits";
import { useT } from "@/components/nexora/language-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "") : `${Date.now()}${Math.random().toString(36).slice(2)}`);

const KINDS = [
  { value: "damage", label: "stock.kind.damage", hint: "stock.hintDamage" },
  { value: "return_in", label: "stock.kind.returnIn", hint: "stock.hintReturn" },
  { value: "count", label: "stock.kind.count", hint: "stock.hintCount" },
] as const;

export function AdjustmentForm({ productId, units, baseUnit, baseUnitLabel }: { productId: string; units: { code: string; label: string }[]; baseUnit: string; baseUnitLabel: string }) {
  const t = useT();
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);
  const [kind, setKind] = useState<(typeof KINDS)[number]["value"]>("damage");
  const [state, action] = useActionState<AdjustmentFormState, FormData>(async (previous, formData) => {
    const result = await recordAdjustmentAction(previous, formData);
    // A saved adjustment gets a fresh key so the next one is a new request; a refused one keeps it.
    if (result.result) setIdempotencyKey(newKey());
    return result;
  }, {});
  const values = state.result ? {} : (state.values ?? {});
  const errors = state.fieldErrors ?? {};

  return (
    <form key={state.result?.id ?? "adjust"} action={action} className="flex flex-col gap-3">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="kind" value={kind} />
      <div role="radiogroup" aria-label={t("stock.whatHappened")} className="grid grid-cols-3 gap-1 rounded-xl bg-muted p-1">
        {KINDS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={kind === option.value}
            onClick={() => setKind(option.value)}
            className={`min-h-10 rounded-lg px-2 text-sm font-semibold ${kind === option.value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
          >
            {t(option.label)}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t(KINDS.find((option) => option.value === kind)!.hint)}</p>
      {kind === "count" ? (
        <Field label={t("stock.countFound")} error={errors.direction}>
          <FormSelect name="direction" defaultValue={values.direction ?? ""}>
            <option value="" disabled>
              {t("common.choose")}
            </option>
            <option value="in">{t("stock.more")}</option>
            <option value="out">{t("stock.fewer")}</option>
          </FormSelect>
        </Field>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("common.quantity")} error={errors.quantity}>
          <Input name="quantity" defaultValue={values.quantity} inputMode="decimal" placeholder={t("stock.qtyPlaceholder", { qty: 1 })} className="h-11 tabular-nums" />
        </Field>
        <Field label={t("common.unit")} error={errors.unit}>
          <FormSelect name="unit" defaultValue={values.unit ?? baseUnit}>
            {units.map((unit) => (
              <option key={unit.code} value={unit.code}>
                {unit.label}
              </option>
            ))}
          </FormSelect>
        </Field>
      </div>
      <Field label={t("common.reason")} hint={t("stock.reasonHint")} error={errors.reason}>
        <Input name="reason" defaultValue={values.reason} maxLength={200} placeholder={t("stock.reasonPlaceholder")} className="h-11" />
      </Field>
      <FormAlert
        error={state.fieldErrors ? undefined : state.error}
        message={state.result ? t("stock.adjustmentSaved", { number: state.result.number, change: state.result.qtyChange, qty: state.result.newQty, unit: baseUnitLabel }) : undefined}
      />
      <div>
        <SubmitButton>{t("stock.saveAdjustment")}</SubmitButton>
      </div>
    </form>
  );
}

export function RebuildCacheButton({ productId }: { productId: string }) {
  const t = useT();
  const [state, action] = useActionState(rebuildCacheAction, {});
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="productId" value={productId} />
      <Button type="submit" variant="outline" size="touch" className="self-start">
        {t("stock.recalculate")}
      </Button>
      {state.error ? (
        <p role="alert" className="text-xs text-danger">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
