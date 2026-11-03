"use client";

import { useActionState, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addSlabAction, setSlabActiveAction, updateSlabAction, type PricingFormState } from "@/app/(app)/pricing/actions";
import { Field, FormAlert, SubmitButton } from "@/components/catalog/form-bits";
import { useT } from "@/components/nexora/language-provider";
import { unitShort } from "@/shared/i18n/unit-labels";

export type SlabView = {
  id: string;
  /** "1–49 pc", "100+ pc": worked out on the server from the saved slabs. */
  rangeLabel: string;
  minQty: string;
  priceText: string;
  priceInput: string;
  isActive: boolean;
  belowCost: boolean | null;
  /** Owner only: margin over cost, e.g. "8.6%". */
  marginText: string | null;
};

function ConfirmBelowCost({ show, defaultChecked }: { show: boolean; defaultChecked?: boolean }) {
  const t = useT();
  if (!show) return null;
  return (
    <label className="flex min-h-11 items-start gap-2 rounded-lg bg-amber-soft px-3 py-2 text-sm text-amber-ink">
      <input type="checkbox" name="confirmBelowCost" defaultChecked={defaultChecked} className="mt-0.5 size-5 shrink-0 accent-[var(--teal-strong)]" />
      {t("pricing.confirmBelowCost")}
    </label>
  );
}

function SlabRow({ productId, baseUnit, slab }: { productId: string; baseUnit: string; slab: SlabView }) {
  const t = useT();
  const unit = unitShort(t, baseUnit);
  const [editing, setEditing] = useState(false);
  const [updateState, updateAction] = useActionState<PricingFormState, FormData>(async (previous, formData) => {
    const result = await updateSlabAction(previous, formData);
    if (result.ok) setEditing(false);
    return result;
  }, {});
  const [toggleState, toggleAction] = useActionState<PricingFormState, FormData>(setSlabActiveAction, {});

  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 text-sm">
          <p className="text-foreground">
            <span className="font-semibold">{slab.rangeLabel}:</span> <span className="font-semibold tabular-nums">{slab.priceText}</span> {t("pricing.perUnit", { unit })}
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {!slab.isActive ? <Badge variant="neutral">{t("pricing.retired")}</Badge> : null}
            {slab.belowCost ? <Badge variant="danger">{t("pricing.belowCost")}</Badge> : null}
            {slab.marginText ? <span className="text-xs text-muted-foreground">{t("pricing.margin", { value: slab.marginText })}</span> : null}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          {slab.isActive ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing((value) => !value)}>
              {editing ? t("common.cancel") : t("pricing.changePrice")}
            </Button>
          ) : null}
          <form action={toggleAction}>
            <input type="hidden" name="productId" value={productId} />
            <input type="hidden" name="slabId" value={slab.id} />
            <input type="hidden" name="active" value={slab.isActive ? "false" : "true"} />
            <Button type="submit" size="sm" variant="outline">
              {t(slab.isActive ? "pricing.retire" : "pricing.useAgain")}
            </Button>
          </form>
        </div>
      </div>
      {editing ? (
        <form key={updateState.nonce ?? "edit"} action={updateAction} className="flex flex-col gap-2">
          <input type="hidden" name="productId" value={productId} />
          <input type="hidden" name="slabId" value={slab.id} />
          <div className="flex flex-wrap items-end gap-2">
            <Field label={t("pricing.pricePer", { unit })} error={updateState.fieldErrors?.price ?? updateState.error}>
              <Input name="price" defaultValue={updateState.values?.price ?? slab.priceInput} inputMode="decimal" className="h-11 w-36 tabular-nums" />
            </Field>
            <SubmitButton>{t("pricing.savePrice")}</SubmitButton>
          </div>
          <ConfirmBelowCost show={Boolean(updateState.needsCostConfirm)} />
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

export function SlabSection({
  productId,
  baseUnit,
  allowDecimal,
  wholesaleText,
  baselineLabel,
  slabs,
}: {
  productId: string;
  baseUnit: string;
  allowDecimal: boolean;
  wholesaleText: string;
  /** "1–49 pc" (below the first slab), or null when there are no slabs. */
  baselineLabel: string | null;
  slabs: SlabView[];
}) {
  const t = useT();
  const unit = unitShort(t, baseUnit);
  const [state, action] = useActionState<PricingFormState, FormData>(addSlabAction, {});
  const active = slabs.filter((slab) => slab.isActive);
  const retired = slabs.filter((slab) => !slab.isActive);
  const values = state.values ?? {};

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {t("pricing.slabsHelp", { unit })}
      </p>
      {active.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">
          {t("pricing.noSlabs", { amount: wholesaleText, unit })}
        </p>
      ) : null}
      {baselineLabel ? (
        <p className="text-sm text-foreground">
          <span className="font-semibold">{baselineLabel}:</span> <span className="font-semibold tabular-nums">{wholesaleText}</span> {t("pricing.perUnit", { unit })}{" "}
          <span className="text-muted-foreground">{t("pricing.wholesalePrice")}</span>
        </p>
      ) : null}
      {slabs.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border">
          {[...active, ...retired].map((slab) => (
            <SlabRow key={slab.id} productId={productId} baseUnit={baseUnit} slab={slab} />
          ))}
        </ul>
      ) : null}

      <form key={state.nonce ?? "add"} action={action} className="flex flex-col gap-3 border-t border-border pt-4">
        <input type="hidden" name="productId" value={productId} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("pricing.fromQuantity", { unit })} hint={t(allowDecimal ? "pricing.minDecimalHint" : "pricing.minWholeHint")} error={state.fieldErrors?.minQty}>
            <Input name="minQty" defaultValue={values.minQty} inputMode="decimal" placeholder={t("pricing.exampleSlabQty")} className="h-11 tabular-nums" />
          </Field>
          <Field label={t("pricing.pricePer", { unit })} hint={t("pricing.notAboveWholesale", { amount: wholesaleText })} error={state.fieldErrors?.price}>
            <Input name="price" defaultValue={values.price} inputMode="decimal" placeholder={t("pricing.exampleSlabPrice")} className="h-11 tabular-nums" />
          </Field>
        </div>
        <ConfirmBelowCost show={Boolean(state.needsCostConfirm)} />
        <FormAlert error={state.fieldErrors ? undefined : state.error} message={state.message} />
        <div>
          <SubmitButton variant="outline">{t("pricing.addSlab")}</SubmitButton>
        </div>
      </form>
    </div>
  );
}

export { ConfirmBelowCost };
