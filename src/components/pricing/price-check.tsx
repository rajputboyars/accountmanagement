"use client";

import { useActionState } from "react";
import { Calculator, TriangleAlert } from "lucide-react";
import { quoteAction, type QuoteFormState } from "@/app/(app)/pricing/actions";
import { Field, FormAlert, FormSelect, SubmitButton } from "@/components/catalog/form-bits";
import { useT } from "@/components/nexora/language-provider";
import { Money } from "@/components/nexora/money";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { unitName, unitShort } from "@/shared/i18n/unit-labels";

/**
 * Server-backed price check. Every number shown comes from the server's quote; nothing is
 * calculated here, and nothing is saved.
 */
export function PriceCheck({
  productId,
  units,
  customers,
}: {
  productId: string;
  units: { code: string; label: string }[];
  customers: { id: string; name: string; typeLabel: string }[];
}) {
  const t = useT();
  const [state, action] = useActionState<QuoteFormState, FormData>(quoteAction, {});
  const values = state.values ?? {};
  const quote = state.quote;
  const saleName = quote ? unitName(t, quote.saleUnit.code, quote.saleUnit.name).toLowerCase() : "";
  const baseShort = quote ? unitShort(t, quote.product.baseUnit) : "";

  return (
    <div className="flex flex-col gap-4">
      <form action={action} className="grid gap-3 sm:grid-cols-2">
        <input type="hidden" name="productId" value={productId} />
        <Field label={t("common.quantity")} error={state.fieldErrors?.quantity}>
          <Input name="quantity" defaultValue={values.quantity ?? ""} inputMode="decimal" placeholder={t("pricing.exampleQty")} className="h-11 tabular-nums" />
        </Field>
        <Field label={t("common.unit")} error={state.fieldErrors?.unit}>
          <FormSelect name="unit" defaultValue={values.unit ?? units[0]?.code ?? ""}>
            {units.map((unit) => (
              <option key={unit.code} value={unit.code}>
                {unit.label}
              </option>
            ))}
          </FormSelect>
        </Field>
        <Field label={<span>{t("common.customer.label")} <span className="font-normal text-muted-foreground">{t("common.optional")}</span></span>} error={state.fieldErrors?.customerId}>
          <FormSelect name="customerId" defaultValue={values.customerId ?? ""}>
            <option value="">{t("pricing.noCustomer")}</option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name} ({customer.typeLabel})
              </option>
            ))}
          </FormSelect>
        </Field>
        <Field label={t("pricing.priceList")}>
          <FormSelect name="priceList" defaultValue={values.priceList ?? ""}>
            <option value="">{t("pricing.fromType")}</option>
            <option value="wholesale">{t("common.wholesale")}</option>
            <option value="retail">{t("common.retail")}</option>
          </FormSelect>
        </Field>
        <div className="sm:col-span-2">
          <SubmitButton variant="outline">
            <Calculator aria-hidden="true" />
            {t("pricing.checkPrice")}
          </SubmitButton>
        </div>
      </form>

      <FormAlert error={state.fieldErrors ? undefined : state.error} />

      {quote ? (
        <section aria-live="polite" aria-label={t("pricing.resultLabel")} className="flex flex-col gap-3 rounded-2xl border border-border bg-muted/40 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-muted-foreground">
                {quote.quantity} {saleName}
                {quote.saleUnit.code !== quote.product.baseUnit ? ` (${quote.baseQuantity} ${baseShort})` : ""} · {quote.customer?.name ?? t("pricing.walkIn")} ·{" "}
                {t(quote.priceList === "wholesale" ? "common.wholesale" : "common.retail")}
              </p>
              <p className="mt-1 text-2xl font-bold text-foreground">
                <Money paise={quote.lineAmountPaise} withPaise />
              </p>
              <p className="text-xs text-muted-foreground">{t("pricing.lineAmount")}</p>
            </div>
            <Badge variant="info">{quote.badge}</Badge>
          </div>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-muted-foreground">{t("pricing.ratePer", { unit: baseShort })}</dt>
              <dd className="font-semibold text-foreground">
                <Money paise={quote.baseRatePaise} withPaise />
              </dd>
            </div>
            {quote.saleUnit.code !== quote.product.baseUnit ? (
              <div>
                <dt className="text-muted-foreground">{t("pricing.ratePer", { unit: saleName })}</dt>
                <dd className="font-semibold text-foreground">
                  <Money paise={quote.saleUnitRatePaise} withPaise />
                </dd>
              </div>
            ) : null}
          </dl>
          <div className="text-sm">
            <p className="font-medium text-foreground">{t("pricing.whyPrice")}</p>
            <ol className="mt-1 flex list-decimal flex-col gap-1 pl-5 text-muted-foreground">
              <li>{quote.priceListReason}</li>
              {quote.explanation.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ol>
          </div>
          {quote.belowCost ? (
            <p className="flex gap-2 rounded-xl bg-amber-soft px-3 py-2 text-sm text-amber-ink">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {t("pricing.belowCostWarning")}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">{t("pricing.previewOnly")}</p>
        </section>
      ) : null}
    </div>
  );
}
