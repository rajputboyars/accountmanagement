"use client";

import { useActionState, useState } from "react";
import { rebuildCacheAction, recordAdjustmentAction, type AdjustmentFormState } from "@/app/(app)/inventory/stock/actions";
import { Field, FormAlert, FormSelect, SubmitButton } from "@/components/catalog/form-bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "") : `${Date.now()}${Math.random().toString(36).slice(2)}`);

const KINDS = [
  { value: "damage", label: "Damaged", hint: "Removes stock." },
  { value: "return_in", label: "Customer return", hint: "Adds stock back. It doesn't change the customer's balance." },
  { value: "count", label: "Count fix", hint: "When a count finds more or fewer than the system shows." },
] as const;

export function AdjustmentForm({ productId, units, baseUnit }: { productId: string; units: { code: string; label: string }[]; baseUnit: string }) {
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
      <div role="radiogroup" aria-label="What happened" className="grid grid-cols-3 gap-1 rounded-xl bg-muted p-1">
        {KINDS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={kind === option.value}
            onClick={() => setKind(option.value)}
            className={`min-h-10 rounded-lg px-2 text-sm font-semibold ${kind === option.value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{KINDS.find((option) => option.value === kind)?.hint}</p>
      {kind === "count" ? (
        <Field label="The count found" error={errors.direction}>
          <FormSelect name="direction" defaultValue={values.direction ?? ""}>
            <option value="" disabled>
              Choose…
            </option>
            <option value="in">More than the system shows (add)</option>
            <option value="out">Fewer than the system shows (remove)</option>
          </FormSelect>
        </Field>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Quantity" error={errors.quantity}>
          <Input name="quantity" defaultValue={values.quantity} inputMode="decimal" placeholder="e.g. 1" className="h-11 tabular-nums" />
        </Field>
        <Field label="Unit" error={errors.unit}>
          <FormSelect name="unit" defaultValue={values.unit ?? baseUnit}>
            {units.map((unit) => (
              <option key={unit.code} value={unit.code}>
                {unit.label}
              </option>
            ))}
          </FormSelect>
        </Field>
      </div>
      <Field label="Reason" hint="Required. Shown in the stock history and the audit log." error={errors.reason}>
        <Input name="reason" defaultValue={values.reason} maxLength={200} placeholder="e.g. Cracked while unloading" className="h-11" />
      </Field>
      <FormAlert
        error={state.fieldErrors ? undefined : state.error}
        message={state.result ? `${state.result.number} saved: ${state.result.qtyChange} ${state.result.baseUnit}, now ${state.result.newQty} ${state.result.baseUnit}.` : undefined}
      />
      <div>
        <SubmitButton>Save adjustment</SubmitButton>
      </div>
    </form>
  );
}

export function RebuildCacheButton({ productId }: { productId: string }) {
  const [state, action] = useActionState(rebuildCacheAction, {});
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="productId" value={productId} />
      <Button type="submit" variant="outline" size="touch" className="self-start">
        Recalculate from stock entries
      </Button>
      {state.error ? (
        <p role="alert" className="text-xs text-danger">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
