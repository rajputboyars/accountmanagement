"use client";

import { useActionState } from "react";
import { useT } from "@/components/nexora/language-provider";
import { Input } from "@/components/ui/input";
import type { Translate } from "@/shared/i18n";
import { unitName, unitShort } from "@/shared/i18n/unit-labels";
import { createProductAction, updateProductAction, type CatalogFormState } from "@/app/(app)/inventory/actions";
import { Field, FormAlert, FormSelect, SubmitButton, textareaClass } from "./form-bits";
import { HelpHint } from "@/components/nexora/help-hint";

export type ProductFormValues = {
  name: string;
  sku: string;
  barcode: string;
  categoryName: string;
  description: string;
  baseUnit: string;
  hsn: string;
  gstRateBp: string;
  retailPrice: string;
  wholesalePrice: string;
  costPrice: string;
  reorderLevel: string;
};

const gstLabel = (t: Translate, rate: number) => (rate === 0 ? t("product.gstNil") : `${(rate / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`);

type Props = {
  mode: "create" | "edit";
  initial: ProductFormValues;
  units: { code: string; name: string }[];
  categories: string[];
  productId?: string;
  version?: number;
  /** Owner only: the cost price field is shown and saved. */
  canSeeCost: boolean;
  /** False once packaging units exist (they are measured in the base unit). */
  baseUnitEditable: boolean;
  /** GST rates the shop uses (Settings → GST), in basis points. */
  gstRates: number[];
};

export function ProductForm({ mode, initial, units, categories, productId, version, canSeeCost, baseUnitEditable, gstRates }: Props) {
  const t = useT();
  const [state, action] = useActionState<CatalogFormState, FormData>(mode === "create" ? createProductAction : updateProductAction, {});
  const values: ProductFormValues = { ...initial, ...(state.values as Partial<ProductFormValues> | undefined) };
  const errors = state.fieldErrors ?? {};
  const invalid = (name: string) => (errors[name] ? true : undefined);

  return (
    <form key={state.nonce ?? "form"} action={action} className="flex flex-col gap-6" noValidate>
      {productId ? <input type="hidden" name="productId" value={productId} /> : null}
      {version ? <input type="hidden" name="version" value={version} /> : null}

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 text-sm font-semibold text-foreground">{t("product.basic")}</legend>
        <Field label={t("product.name")} error={errors.name} className="sm:col-span-2">
          <Input name="name" defaultValue={values.name} maxLength={120} required aria-invalid={invalid("name")} placeholder={t("product.namePlaceholder")} className="h-11" />
        </Field>
        <Field label={t("product.sku")} hint={t("product.skuHint")} error={errors.sku}>
          <Input name="sku" defaultValue={values.sku} maxLength={30} required aria-invalid={invalid("sku")} placeholder={t("product.skuPlaceholder")} className="h-11 uppercase placeholder:normal-case" />
        </Field>
        <Field label={<span>{t("inventory.barcode")} <span className="font-normal text-muted-foreground">{t("common.optional")}</span></span>} error={errors.barcode}>
          <Input name="barcode" defaultValue={values.barcode} maxLength={30} inputMode="numeric" aria-invalid={invalid("barcode")} className="h-11" />
        </Field>
        <Field label={<span>{t("common.category")} <span className="font-normal text-muted-foreground">{t("common.optional")}</span></span>} hint={t("product.categoryHint")} error={errors.categoryName}>
          <Input name="categoryName" defaultValue={values.categoryName} maxLength={60} list="category-options" aria-invalid={invalid("categoryName")} placeholder={t("product.categoryPlaceholder")} className="h-11" />
          <datalist id="category-options">
            {categories.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </Field>
        <Field label={<span>{t("inventory.description")} <span className="font-normal text-muted-foreground">{t("common.optional")}</span></span>} error={errors.description} className="sm:col-span-2">
          <textarea name="description" defaultValue={values.description} maxLength={500} rows={2} aria-invalid={invalid("description")} className={textareaClass} />
        </Field>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-3">
        <legend className="mb-3 text-sm font-semibold text-foreground">{t("product.unitTax")}</legend>
        <Field
          label={t("inventory.baseUnit")}
          hint={baseUnitEditable ? t("product.baseUnitHint") : t("product.baseUnitLocked")}
          error={errors.baseUnit}
        >
          {baseUnitEditable ? (
            <FormSelect name="baseUnit" defaultValue={values.baseUnit} aria-invalid={invalid("baseUnit")}>
              <option value="" disabled>
                {t("common.choose")}
              </option>
              {units.map((unit) => (
                <option key={unit.code} value={unit.code}>
                  {unitName(t, unit.code, unit.name)} ({unitShort(t, unit.code)})
                </option>
              ))}
            </FormSelect>
          ) : (
            <>
              <input type="hidden" name="baseUnit" value={values.baseUnit} />
              <Input value={unitName(t, values.baseUnit, units.find((unit) => unit.code === values.baseUnit)?.name ?? values.baseUnit)} readOnly disabled className="h-11" />
            </>
          )}
        </Field>
        <Field label={t("product.hsn")} hint={t("product.hsnHint")} error={errors.hsn}>
          <Input name="hsn" defaultValue={values.hsn} inputMode="numeric" maxLength={8} aria-invalid={invalid("hsn")} placeholder={t("product.hsnPlaceholder")} className="h-11" />
        </Field>
        <Field label={t("product.gstRate")} error={errors.gstRateBp}>
          <FormSelect name="gstRateBp" defaultValue={values.gstRateBp} aria-invalid={invalid("gstRateBp")}>
            {[...new Set([...gstRates, ...(values.gstRateBp ? [Number(values.gstRateBp)] : [])])]
              .sort((a, b) => a - b)
              .map((rate) => (
                <option key={rate} value={String(rate)}>
                  {gstLabel(t, rate)}
                </option>
              ))}
          </FormSelect>
        </Field>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-3">
        <legend className="mb-1 text-sm font-semibold text-foreground">{t("product.sellingPrices")} <HelpHint topic="sellingPrice" className="text-muted-foreground" /></legend>
        <p className="text-xs text-muted-foreground sm:col-span-3">{t("product.slabsLater")}</p>
        <Field label={t("product.retailPrice")} error={errors.retailPrice}>
          <Input name="retailPrice" defaultValue={values.retailPrice} inputMode="decimal" aria-invalid={invalid("retailPrice")} placeholder={t("product.pricePlaceholder", { amount: 320 })} className="h-11 tabular-nums" />
        </Field>
        <Field label={t("product.wholesalePrice")} error={errors.wholesalePrice}>
          <Input name="wholesalePrice" defaultValue={values.wholesalePrice} inputMode="decimal" aria-invalid={invalid("wholesalePrice")} placeholder={t("product.pricePlaceholder", { amount: 275 })} className="h-11 tabular-nums" />
        </Field>
        {canSeeCost ? (
          <Field label={<span>{t("product.costPrice")} <span className="font-normal text-muted-foreground">{t("common.optional")}</span></span>} hint={t("product.costHint")} error={errors.costPrice}>
            <Input name="costPrice" defaultValue={values.costPrice} inputMode="decimal" aria-invalid={invalid("costPrice")} placeholder={t("product.pricePlaceholder", { amount: 240 })} className="h-11 tabular-nums" />
          </Field>
        ) : null}
      </fieldset>

      <Field help="reorderLevel" label={t("product.lowAlert")} hint={t("product.lowAlertHint")} error={errors.reorderLevel}>
        <Input name="reorderLevel" defaultValue={values.reorderLevel} inputMode="decimal" aria-invalid={invalid("reorderLevel")} placeholder={t("product.pricePlaceholder", { amount: 10 })} className="h-11 max-w-40 tabular-nums" />
      </Field>

      <FormAlert error={state.fieldErrors ? t("inventory.fixFields") : state.error} message={state.message} />

      <div className="flex flex-wrap gap-3">
        <SubmitButton>{mode === "create" ? t("product.save") : t("common.saveChanges")}</SubmitButton>
      </div>
    </form>
  );
}
