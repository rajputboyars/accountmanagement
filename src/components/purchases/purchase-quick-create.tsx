"use client";

import { useState, useTransition } from "react";
import { LoaderCircle, X } from "lucide-react";
import { linkSupplierProductsAction, quickCreateProductAction, saveSupplierAction, type QuickProductResult } from "@/app/(app)/purchases/actions";
import { Field, FormAlert, selectClass } from "@/components/catalog/form-bits";
import { useT } from "@/components/nexora/language-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Translate } from "@/shared/i18n";

/** What the purchase screens need to offer quick-add of a product (owner only: it sets selling prices). */
export type ProductQuickCreate = { units: { code: string; label: string }[]; gstRates: number[]; canSeeCost: boolean };
export type QuickProduct = NonNullable<QuickProductResult["product"]>;

const gstLabel = (t: Translate, rate: number) => (rate === 0 ? t("product.gstNil") : `${(rate / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`);

function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const t = useT();
  return (
    <section data-guide="purchase-quick-panel" className="flex flex-col gap-3 rounded-xl border border-teal/40 bg-muted/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <Button type="button" variant="ghost" size="icon" className="size-11" aria-label={t("purchases.qc.close")} onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </div>
      {children}
    </section>
  );
}

/** Adds a supplier with the Suppliers screen's own action and rules, without leaving the purchase. */
export function QuickSupplierPanel({ onCreated, onClose }: { onCreated: (supplier: { id: string; name: string }) => void; onClose: () => void }) {
  const t = useT();
  const [values, setValues] = useState({ name: "", phone: "", gstin: "", paymentTermsDays: "30" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const set = (name: keyof typeof values) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setValues((all) => ({ ...all, [name]: event.target.value }));
    setErrors((all) => ({ ...all, [name]: "" }));
  };
  const submit = () =>
    startTransition(async () => {
      const formData = new FormData();
      for (const [name, value] of Object.entries(values)) formData.set(name, value);
      const result = await saveSupplierAction({}, formData);
      if (result.ok && result.id) {
        onCreated({ id: result.id, name: values.name.trim() });
        return;
      }
      setErrors(result.fieldErrors ?? {});
      setError(result.fieldErrors ? undefined : result.error);
    });
  return (
    <Panel title={t("purchases.qc.supplierTitle")} onClose={onClose}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("common.name")} error={errors.name} className="sm:col-span-2">
          <Input data-guide="quick-supplier-name" value={values.name} onChange={set("name")} maxLength={120} placeholder={t("suppliers.namePlaceholder")} aria-invalid={errors.name ? true : undefined} className="h-11" />
        </Field>
        <Field label={<span>{t("common.phone")} <span className="font-normal text-muted-foreground">{t("common.optional")}</span></span>} error={errors.phone}>
          <Input value={values.phone} onChange={set("phone")} inputMode="tel" className="h-11" />
        </Field>
        <Field label={t("suppliers.terms")} error={errors.paymentTermsDays}>
          <Input value={values.paymentTermsDays} onChange={set("paymentTermsDays")} inputMode="numeric" className="h-11 tabular-nums" />
        </Field>
        <Field label={<span>GSTIN <span className="font-normal text-muted-foreground">{t("common.optional")}</span></span>} error={errors.gstin} className="sm:col-span-2">
          <Input value={values.gstin} onChange={set("gstin")} maxLength={15} className="h-11 uppercase" />
        </Field>
      </div>
      <FormAlert error={error} />
      <Button type="button" size="touch" className="self-start" disabled={pending} onClick={submit}>
        {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
        {t("suppliers.addButton")}
      </Button>
    </Panel>
  );
}

/** Adds a product with the catalog's own rules and links it to the supplier in the same step. */
export function QuickProductPanel({ supplier, options, onCreated, onClose }: { supplier: { id: string; name: string }; options: ProductQuickCreate; onCreated: (product: QuickProduct) => void; onClose: () => void }) {
  const t = useT();
  const [values, setValues] = useState({
    name: "",
    sku: "",
    baseUnit: options.units.some((unit) => unit.code === "pc") ? "pc" : (options.units[0]?.code ?? ""),
    hsn: "",
    gstRateBp: String(options.gstRates.includes(1800) ? 1800 : (options.gstRates[0] ?? 0)),
    retailPrice: "",
    wholesalePrice: "",
    costPrice: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const set = (name: keyof typeof values) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setValues((all) => ({ ...all, [name]: event.target.value }));
    setErrors((all) => ({ ...all, [name]: "" }));
  };
  const invalid = (name: string) => (errors[name] ? true : undefined);
  const submit = () =>
    startTransition(async () => {
      const result = await quickCreateProductAction(supplier.id, values);
      if (result.ok && result.product) {
        onCreated(result.product);
        return;
      }
      setErrors(result.fieldErrors ?? {});
      setError(result.fieldErrors ? t("inventory.fixFields") : result.error);
    });
  return (
    <Panel title={t("purchases.qc.productTitle", { supplier: supplier.name })} onClose={onClose}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("product.name")} error={errors.name} className="sm:col-span-2">
          <Input data-guide="quick-product-name" value={values.name} onChange={set("name")} maxLength={120} placeholder={t("product.namePlaceholder")} aria-invalid={invalid("name")} className="h-11" />
        </Field>
        <Field label={t("product.sku")} hint={t("product.skuHint")} error={errors.sku}>
          <Input value={values.sku} onChange={set("sku")} maxLength={30} placeholder={t("product.skuPlaceholder")} aria-invalid={invalid("sku")} className="h-11 uppercase placeholder:normal-case" />
        </Field>
        <Field label={t("inventory.baseUnit")} error={errors.baseUnit}>
          <select value={values.baseUnit} onChange={set("baseUnit")} aria-invalid={invalid("baseUnit")} className={selectClass}>
            {options.units.map((unit) => (
              <option key={unit.code} value={unit.code}>
                {unit.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("product.hsn")} hint={t("product.hsnHint")} error={errors.hsn}>
          <Input value={values.hsn} onChange={set("hsn")} inputMode="numeric" maxLength={8} placeholder={t("product.hsnPlaceholder")} aria-invalid={invalid("hsn")} className="h-11" />
        </Field>
        <Field label={t("product.gstRate")} error={errors.gstRateBp}>
          <select value={values.gstRateBp} onChange={set("gstRateBp")} aria-invalid={invalid("gstRateBp")} className={selectClass}>
            {options.gstRates.map((rate) => (
              <option key={rate} value={String(rate)}>
                {gstLabel(t, rate)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("product.retailPrice")} error={errors.retailPrice}>
          <Input value={values.retailPrice} onChange={set("retailPrice")} inputMode="decimal" placeholder={t("product.pricePlaceholder", { amount: 320 })} aria-invalid={invalid("retailPrice")} className="h-11 tabular-nums" />
        </Field>
        <Field label={t("product.wholesalePrice")} error={errors.wholesalePrice}>
          <Input value={values.wholesalePrice} onChange={set("wholesalePrice")} inputMode="decimal" placeholder={t("product.pricePlaceholder", { amount: 275 })} aria-invalid={invalid("wholesalePrice")} className="h-11 tabular-nums" />
        </Field>
        {options.canSeeCost ? (
          <Field label={<span>{t("product.costPrice")} <span className="font-normal text-muted-foreground">{t("common.optional")}</span></span>} error={errors.costPrice}>
            <Input value={values.costPrice} onChange={set("costPrice")} inputMode="decimal" placeholder={t("product.pricePlaceholder", { amount: 240 })} aria-invalid={invalid("costPrice")} className="h-11 tabular-nums" />
          </Field>
        ) : null}
      </div>
      <FormAlert error={error} />
      <Button type="button" size="touch" className="self-start" disabled={pending} onClick={submit}>
        {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
        {t("purchases.qc.saveProduct")}
      </Button>
    </Panel>
  );
}

/** Links a product the shop already has to the supplier, so it is never created twice. */
export function LinkProductPanel({ supplier, candidates, onLinked, onClose }: { supplier: { id: string; name: string }; candidates: { id: string; name: string; sku: string }[]; onLinked: (productId: string) => void; onClose: () => void }) {
  const t = useT();
  const [productId, setProductId] = useState("");
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const submit = () =>
    startTransition(async () => {
      const result = await linkSupplierProductsAction(supplier.id, [productId]);
      if (result.ok) onLinked(productId);
      else setError(result.error);
    });
  return (
    <Panel title={t("purchases.qc.linkTitle", { supplier: supplier.name })} onClose={onClose}>
      {candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("purchases.qc.noOthers")}</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{t("purchases.qc.linkHelp")}</p>
          <Field label={t("purchases.qc.pickProduct")}>
            <select data-guide="quick-link-product" value={productId} onChange={(event) => { setProductId(event.target.value); setError(undefined); }} className={selectClass}>
              <option value="">{t("common.choose")}</option>
              {candidates.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name} ({product.sku})
                </option>
              ))}
            </select>
          </Field>
          <FormAlert error={error} />
          <Button type="button" size="touch" className="self-start" disabled={pending || !productId} onClick={submit}>
            {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
            {t("purchases.qc.linkButton")}
          </Button>
        </>
      )}
    </Panel>
  );
}
