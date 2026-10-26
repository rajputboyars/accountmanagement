"use client";

import { useActionState } from "react";
import { Calculator, TriangleAlert } from "lucide-react";
import { quoteAction, type QuoteFormState } from "@/app/(app)/pricing/actions";
import { Field, FormAlert, FormSelect, SubmitButton } from "@/components/catalog/form-bits";
import { Money } from "@/components/nexora/money";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

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
  const [state, action] = useActionState<QuoteFormState, FormData>(quoteAction, {});
  const values = state.values ?? {};
  const quote = state.quote;

  return (
    <div className="flex flex-col gap-4">
      <form action={action} className="grid gap-3 sm:grid-cols-2">
        <input type="hidden" name="productId" value={productId} />
        <Field label="Quantity" error={state.fieldErrors?.quantity}>
          <Input name="quantity" defaultValue={values.quantity ?? ""} inputMode="decimal" placeholder="e.g. 150" className="h-11 tabular-nums" />
        </Field>
        <Field label="Unit" error={state.fieldErrors?.unit}>
          <FormSelect name="unit" defaultValue={values.unit ?? units[0]?.code ?? ""}>
            {units.map((unit) => (
              <option key={unit.code} value={unit.code}>
                {unit.label}
              </option>
            ))}
          </FormSelect>
        </Field>
        <Field label={<span>Customer <span className="font-normal text-muted-foreground">(optional)</span></span>} error={state.fieldErrors?.customerId}>
          <FormSelect name="customerId" defaultValue={values.customerId ?? ""}>
            <option value="">No customer (walk-in)</option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name} ({customer.typeLabel})
              </option>
            ))}
          </FormSelect>
        </Field>
        <Field label="Price list">
          <FormSelect name="priceList" defaultValue={values.priceList ?? ""}>
            <option value="">From the customer type</option>
            <option value="wholesale">Wholesale</option>
            <option value="retail">Retail</option>
          </FormSelect>
        </Field>
        <div className="sm:col-span-2">
          <SubmitButton variant="outline">
            <Calculator aria-hidden="true" />
            Check price
          </SubmitButton>
        </div>
      </form>

      <FormAlert error={state.fieldErrors ? undefined : state.error} />

      {quote ? (
        <section aria-live="polite" aria-label="Price check result" className="flex flex-col gap-3 rounded-2xl border border-border bg-muted/40 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-muted-foreground">
                {quote.quantity} {quote.saleUnit.name.toLowerCase()}
                {quote.saleUnit.code !== quote.product.baseUnit ? ` (${quote.baseQuantity} ${quote.product.baseUnit})` : ""} · {quote.customer?.name ?? "Walk-in"} ·{" "}
                {quote.priceList === "wholesale" ? "Wholesale" : "Retail"}
              </p>
              <p className="mt-1 text-2xl font-bold text-foreground">
                <Money paise={quote.lineAmountPaise} withPaise />
              </p>
              <p className="text-xs text-muted-foreground">Line amount before GST and bill discount</p>
            </div>
            <Badge variant="info">{quote.badge}</Badge>
          </div>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-muted-foreground">Rate per {quote.product.baseUnit}</dt>
              <dd className="font-semibold text-foreground">
                <Money paise={quote.baseRatePaise} withPaise />
              </dd>
            </div>
            {quote.saleUnit.code !== quote.product.baseUnit ? (
              <div>
                <dt className="text-muted-foreground">Rate per {quote.saleUnit.name.toLowerCase()}</dt>
                <dd className="font-semibold text-foreground">
                  <Money paise={quote.saleUnitRatePaise} withPaise />
                </dd>
              </div>
            ) : null}
          </dl>
          <div className="text-sm">
            <p className="font-medium text-foreground">Why this price</p>
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
              This rate is below the cost price.
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">Preview only: no bill, payment or stock change was made.</p>
        </section>
      ) : null}
    </div>
  );
}
