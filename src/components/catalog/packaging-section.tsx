"use client";

import { useActionState, useState } from "react";
import { useT } from "@/components/nexora/language-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  addProductUnitAction,
  setProductUnitActiveAction,
  updateProductUnitAction,
  type CatalogFormState,
} from "@/app/(app)/inventory/actions";
import { unitName, unitShort } from "@/shared/i18n/unit-labels";
import { Field, FormAlert, FormSelect, SubmitButton } from "./form-bits";

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
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [updateState, updateAction] = useActionState<CatalogFormState, FormData>(async (previous, formData) => {
    const result = await updateProductUnitAction(previous, formData);
    if (result.ok) setEditing(false);
    return result;
  }, {});
  const [toggleState, toggleAction] = useActionState<CatalogFormState, FormData>(setProductUnitActiveAction, {});

  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 text-sm text-foreground">
          <span className="font-semibold">1 {unitName(t, conversion.unit, conversion.unitName)}</span> = <span className="font-semibold tabular-nums">{conversion.factor}</span> {unitShort(t, baseUnit.code)}
          {!conversion.isActive ? <Badge variant="neutral" className="ml-2">{t("pack.retired")}</Badge> : null}
        </p>
        {canManage ? (
          <div className="flex shrink-0 gap-1">
            {conversion.isActive ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing((value) => !value)}>
                {editing ? t("common.cancel") : t("pack.changeSize")}
              </Button>
            ) : null}
            <form action={toggleAction}>
              <input type="hidden" name="productId" value={productId} />
              <input type="hidden" name="packagingId" value={conversion.id} />
              <input type="hidden" name="active" value={conversion.isActive ? "false" : "true"} />
              <Button type="submit" size="sm" variant="outline">
                {conversion.isActive ? t("pack.retire") : t("pack.useAgain")}
              </Button>
            </form>
          </div>
        ) : null}
      </div>
      {editing ? (
        <form action={updateAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="productId" value={productId} />
          <input type="hidden" name="packagingId" value={conversion.id} />
          <Field label={t("pack.inOne", { base: unitName(t, baseUnit.code, baseUnit.name), unit: unitName(t, conversion.unit, conversion.unitName) })} error={updateState.fieldErrors?.factor ?? updateState.error}>
            <Input name="factor" defaultValue={conversion.factor} inputMode="decimal" className="h-11 w-36 tabular-nums" />
          </Field>
          <SubmitButton>{t("pack.saveSize")}</SubmitButton>
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
  const t = useT();
  const [state, action] = useActionState<CatalogFormState, FormData>(addProductUnitAction, {});
  const baseName = unitName(t, baseUnit.code, baseUnit.name);
  const active = conversions.filter((conversion) => conversion.isActive);
  const retired = conversions.filter((conversion) => !conversion.isActive);
  const usedCodes = new Set(active.map((conversion) => conversion.unit));
  const choices = unitOptions.filter((unit) => !usedCodes.has(unit.code));

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {t("pack.help", { unit: baseName.toLowerCase(), code: unitShort(t, baseUnit.code) })}
      </p>

      {conversions.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">
          {t("pack.none", { unit: baseName.toLowerCase() })}
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
              <Field label={t("pack.unit")} error={state.fieldErrors?.unit}>
                <FormSelect name="unit" defaultValue={state.values?.unit ?? ""}>
                  <option value="" disabled>
                    {t("common.choose")}
                  </option>
                  {choices.map((unit) => (
                    <option key={unit.code} value={unit.code}>
                      {unitName(t, unit.code, unit.name)}
                    </option>
                  ))}
                </FormSelect>
              </Field>
              <Field
                label={t("pack.baseInPack", { base: baseName })}
                hint={baseUnit.allowDecimal ? t("pack.decimalHint") : t("pack.wholeHint")}
                error={state.fieldErrors?.factor}
              >
                <Input name="factor" defaultValue={state.values?.factor ?? ""} inputMode="decimal" placeholder={t("pack.factorPlaceholder")} className="h-11 tabular-nums" />
              </Field>
            </div>
            <FormAlert error={state.fieldErrors ? undefined : state.error} message={state.message} />
            <div>
              <SubmitButton variant="outline">{t("pack.add")}</SubmitButton>
            </div>
          </form>
        ) : (
          <p className="border-t border-border pt-4 text-sm text-muted-foreground">{t("pack.allSet")}</p>
        )
      ) : null}
    </div>
  );
}
