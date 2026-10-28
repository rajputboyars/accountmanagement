"use client";

import { useActionState } from "react";
import { Input } from "@/components/ui/input";
import { createProductAction, updateProductAction, type CatalogFormState } from "@/app/(app)/inventory/actions";
import { Field, FormAlert, FormSelect, SubmitButton, textareaClass } from "./form-bits";

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

const gstLabel = (rate: number) => (rate === 0 ? "0% (nil / exempt)" : `${(rate / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`);

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
  const [state, action] = useActionState<CatalogFormState, FormData>(mode === "create" ? createProductAction : updateProductAction, {});
  const values: ProductFormValues = { ...initial, ...(state.values as Partial<ProductFormValues> | undefined) };
  const errors = state.fieldErrors ?? {};
  const invalid = (name: string) => (errors[name] ? true : undefined);

  return (
    <form key={state.nonce ?? "form"} action={action} className="flex flex-col gap-6" noValidate>
      {productId ? <input type="hidden" name="productId" value={productId} /> : null}
      {version ? <input type="hidden" name="version" value={version} /> : null}

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 text-sm font-semibold text-foreground">Basic details</legend>
        <Field label="Product name" error={errors.name} className="sm:col-span-2">
          <Input name="name" defaultValue={values.name} maxLength={120} required aria-invalid={invalid("name")} placeholder='e.g. Ball valve ¾" brass' className="h-11" />
        </Field>
        <Field label="Product code (SKU)" hint="Your own short code. Must be unique in your shop." error={errors.sku}>
          <Input name="sku" defaultValue={values.sku} maxLength={30} required aria-invalid={invalid("sku")} placeholder="e.g. BV-075" className="h-11 uppercase" />
        </Field>
        <Field label={<span>Barcode <span className="font-normal text-muted-foreground">(optional)</span></span>} error={errors.barcode}>
          <Input name="barcode" defaultValue={values.barcode} maxLength={30} inputMode="numeric" aria-invalid={invalid("barcode")} className="h-11" />
        </Field>
        <Field label={<span>Category <span className="font-normal text-muted-foreground">(optional)</span></span>} hint="Pick one or type a new name." error={errors.categoryName}>
          <Input name="categoryName" defaultValue={values.categoryName} maxLength={60} list="category-options" aria-invalid={invalid("categoryName")} placeholder="e.g. Valves" className="h-11" />
          <datalist id="category-options">
            {categories.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </Field>
        <Field label={<span>Description <span className="font-normal text-muted-foreground">(optional)</span></span>} error={errors.description} className="sm:col-span-2">
          <textarea name="description" defaultValue={values.description} maxLength={500} rows={2} aria-invalid={invalid("description")} className={textareaClass} />
        </Field>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-3">
        <legend className="mb-3 text-sm font-semibold text-foreground">Unit and tax</legend>
        <Field
          label="Base unit"
          hint={baseUnitEditable ? "The smallest unit you count, e.g. Piece or Meter." : "Locked: pack sizes are set up in this unit."}
          error={errors.baseUnit}
        >
          {baseUnitEditable ? (
            <FormSelect name="baseUnit" defaultValue={values.baseUnit} aria-invalid={invalid("baseUnit")}>
              <option value="" disabled>
                Choose…
              </option>
              {units.map((unit) => (
                <option key={unit.code} value={unit.code}>
                  {unit.name} ({unit.code})
                </option>
              ))}
            </FormSelect>
          ) : (
            <>
              <input type="hidden" name="baseUnit" value={values.baseUnit} />
              <Input value={units.find((unit) => unit.code === values.baseUnit)?.name ?? values.baseUnit} readOnly disabled className="h-11" />
            </>
          )}
        </Field>
        <Field label="HSN code" hint="4, 6 or 8 digits from the GST tariff." error={errors.hsn}>
          <Input name="hsn" defaultValue={values.hsn} inputMode="numeric" maxLength={8} aria-invalid={invalid("hsn")} placeholder="e.g. 8481" className="h-11" />
        </Field>
        <Field label="GST rate" error={errors.gstRateBp}>
          <FormSelect name="gstRateBp" defaultValue={values.gstRateBp} aria-invalid={invalid("gstRateBp")}>
            {[...new Set([...gstRates, ...(values.gstRateBp ? [Number(values.gstRateBp)] : [])])]
              .sort((a, b) => a - b)
              .map((rate) => (
                <option key={rate} value={String(rate)}>
                  {gstLabel(rate)}
                </option>
              ))}
          </FormSelect>
        </Field>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-3">
        <legend className="mb-1 text-sm font-semibold text-foreground">List prices per base unit, before GST</legend>
        <p className="text-xs text-muted-foreground sm:col-span-3">Quantity slabs and customer-specific prices come in a later update.</p>
        <Field label="Retail price (₹)" error={errors.retailPrice}>
          <Input name="retailPrice" defaultValue={values.retailPrice} inputMode="decimal" aria-invalid={invalid("retailPrice")} placeholder="e.g. 320" className="h-11 tabular-nums" />
        </Field>
        <Field label="Wholesale price (₹)" error={errors.wholesalePrice}>
          <Input name="wholesalePrice" defaultValue={values.wholesalePrice} inputMode="decimal" aria-invalid={invalid("wholesalePrice")} placeholder="e.g. 275" className="h-11 tabular-nums" />
        </Field>
        {canSeeCost ? (
          <Field label={<span>Cost price (₹) <span className="font-normal text-muted-foreground">(optional)</span></span>} hint="What you pay. Only you can see this." error={errors.costPrice}>
            <Input name="costPrice" defaultValue={values.costPrice} inputMode="decimal" aria-invalid={invalid("costPrice")} placeholder="e.g. 240" className="h-11 tabular-nums" />
          </Field>
        ) : null}
      </fieldset>

      <Field label="Low-stock alert at" hint="When stock falls to this many (in the base unit), the product shows as Low and you get a reminder. New products start at 10." error={errors.reorderLevel}>
        <Input name="reorderLevel" defaultValue={values.reorderLevel} inputMode="decimal" aria-invalid={invalid("reorderLevel")} placeholder="e.g. 10" className="h-11 max-w-40 tabular-nums" />
      </Field>

      <FormAlert error={state.fieldErrors ? "Please fix the highlighted fields above." : state.error} message={state.message} />

      <div className="flex flex-wrap gap-3">
        <SubmitButton>{mode === "create" ? "Save product" : "Save changes"}</SubmitButton>
      </div>
    </form>
  );
}
