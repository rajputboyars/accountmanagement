"use client";

import { useActionState, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  addProductUnitAction,
  setProductUnitActiveAction,
  updateProductUnitAction,
  type CatalogFormState,
} from "@/app/(app)/inventory/actions";
import { Field, FormAlert, selectClass, SubmitButton } from "./form-bits";

type Conversion = { id: string; unit: string; unitName: string; factor: string; isActive: boolean };

type Props = {
  productId: string;
  baseUnit: { code: string; name: string; allowDecimal: boolean };
  conversions: Conversion[];
  /** Active units of the shop that could become packaging (base unit excluded). */
  unitOptions: { code: string; name: string }[];
  canManage: boolean;
};

function ConversionRow({ productId, baseUnit, conversion, canManage }: { productId: string; baseUnit: Props["baseUnit"]; conversion: Conversion; canManage: boolean }) {
  const [editing, setEditing] = useState(false);
  const [updateState, updateAction] = useActionState<CatalogFormState, FormData>(async (previous, formData) => {
    const result = await updateProductUnitAction(previous, formData);
    if (result.ok) setEditing(false);
    return result;
  }, {});
  const [toggleState, toggleAction] = useActionState<CatalogFormState, FormData>(setProductUnitActiveAction, {});

  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-foreground">
          <span className="font-semibold">1 {conversion.unitName}</span> = <span className="font-semibold tabular-nums">{conversion.factor}</span> {baseUnit.code}
          {!conversion.isActive ? <Badge variant="neutral" className="ml-2">Retired</Badge> : null}
        </p>
        {canManage ? (
          <div className="flex gap-2">
            {conversion.isActive ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing((value) => !value)}>
                {editing ? "Cancel" : "Change size"}
              </Button>
            ) : null}
            <form action={toggleAction}>
              <input type="hidden" name="productId" value={productId} />
              <input type="hidden" name="packagingId" value={conversion.id} />
              <input type="hidden" name="active" value={conversion.isActive ? "false" : "true"} />
              <Button type="submit" size="sm" variant="outline">
                {conversion.isActive ? "Retire" : "Use again"}
              </Button>
            </form>
          </div>
        ) : null}
      </div>
      {editing ? (
        <form action={updateAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="productId" value={productId} />
          <input type="hidden" name="packagingId" value={conversion.id} />
          <Field label={`${baseUnit.name} in one ${conversion.unitName}`} error={updateState.fieldErrors?.factor ?? updateState.error}>
            <Input name="factor" defaultValue={conversion.factor} inputMode="decimal" className="h-11 w-36 tabular-nums" />
          </Field>
          <SubmitButton>Save size</SubmitButton>
        </form>
      ) : null}
      {toggleState.error ? (
        <p role="alert" className="text-xs text-danger">
          {toggleState.error}
        </p>
      ) : null}
    </li>
  );
}

export function PackagingSection({ productId, baseUnit, conversions, unitOptions, canManage }: Props) {
  const [state, action] = useActionState<CatalogFormState, FormData>(addProductUnitAction, {});
  const active = conversions.filter((conversion) => conversion.isActive);
  const retired = conversions.filter((conversion) => !conversion.isActive);
  const usedCodes = new Set(active.map((conversion) => conversion.unit));
  const choices = unitOptions.filter((unit) => !usedCodes.has(unit.code));

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Sell this product in bigger packs as well as by the {baseUnit.name.toLowerCase()}. Enter exactly how many {baseUnit.code} are in each pack: sizes differ between products and brands.
      </p>

      {conversions.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">
          Sold by the {baseUnit.name.toLowerCase()} only. No packs set up yet.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {[...active, ...retired].map((conversion) => (
            <ConversionRow key={conversion.id} productId={productId} baseUnit={baseUnit} conversion={conversion} canManage={canManage} />
          ))}
        </ul>
      )}

      {canManage ? (
        choices.length > 0 ? (
          <form key={state.nonce ?? "add"} action={action} className="flex flex-col gap-3 border-t border-border pt-4">
            <input type="hidden" name="productId" value={productId} />
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <Field label="Pack unit" error={state.fieldErrors?.unit}>
                <select name="unit" defaultValue={state.values?.unit ?? ""} className={selectClass}>
                  <option value="" disabled>
                    Choose…
                  </option>
                  {choices.map((unit) => (
                    <option key={unit.code} value={unit.code}>
                      {unit.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label={`${baseUnit.name} in one pack`}
                hint={baseUnit.allowDecimal ? "Up to 3 decimal places, e.g. 3 or 2.5." : "A whole number, e.g. 50."}
                error={state.fieldErrors?.factor}
              >
                <Input name="factor" defaultValue={state.values?.factor ?? ""} inputMode="decimal" placeholder="50" className="h-11 tabular-nums" />
              </Field>
            </div>
            <FormAlert error={state.fieldErrors ? undefined : state.error} message={state.message} />
            <div>
              <SubmitButton variant="outline">Add pack unit</SubmitButton>
            </div>
          </form>
        ) : (
          <p className="border-t border-border pt-4 text-sm text-muted-foreground">Every active unit is already set up. Add more units on the Units page.</p>
        )
      ) : null}
    </div>
  );
}
