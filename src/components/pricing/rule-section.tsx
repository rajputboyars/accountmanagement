"use client";

import { useActionState, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addRuleAction, setRuleActiveAction, updateRuleAction, type PricingFormState } from "@/app/(app)/pricing/actions";
import { Field, FormAlert, FormSelect, SubmitButton } from "@/components/catalog/form-bits";
import { useT } from "@/components/nexora/language-provider";
import { unitShort } from "@/shared/i18n/unit-labels";
import { ConfirmBelowCost } from "./slab-section";

export type RuleView = {
  id: string;
  customerName: string;
  kind: "fixed" | "pct";
  /** "Special ₹430.00 per pc from 100 pc" / "1% off all products". */
  summary: string;
  isActive: boolean;
  /** For the edit form. */
  priceInput: string;
  percentInput: string;
  minQty: string;
  /** All-products rules are listed for context but changed on the Pricing page. */
  appliesToAll: boolean;
  belowCost: boolean | null;
};

function RuleRow({ rule, productId }: { rule: RuleView; productId: string }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [updateState, updateAction] = useActionState<PricingFormState, FormData>(async (previous, formData) => {
    const result = await updateRuleAction(previous, formData);
    if (result.ok) setEditing(false);
    return result;
  }, {});
  const [toggleState, toggleAction] = useActionState<PricingFormState, FormData>(setRuleActiveAction, {});
  const values = updateState.values ?? {};

  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 text-sm">
          <p className="font-semibold text-foreground">{rule.customerName}</p>
          <p className="text-muted-foreground">{rule.summary}</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {!rule.isActive ? <Badge variant="neutral">{t("pricing.retired")}</Badge> : null}
            {rule.belowCost ? <Badge variant="danger">{t("pricing.belowCost")}</Badge> : null}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          {rule.isActive ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing((value) => !value)}>
              {editing ? t("common.cancel") : t("pricing.change")}
            </Button>
          ) : null}
          <form action={toggleAction}>
            <input type="hidden" name="productId" value={productId} />
            <input type="hidden" name="ruleId" value={rule.id} />
            <input type="hidden" name="active" value={rule.isActive ? "false" : "true"} />
            <Button type="submit" size="sm" variant="outline">
              {t(rule.isActive ? "pricing.retire" : "pricing.useAgain")}
            </Button>
          </form>
        </div>
      </div>
      {editing ? (
        <form key={updateState.nonce ?? "edit"} action={updateAction} className="flex flex-col gap-2">
          <input type="hidden" name="productId" value={productId} />
          <input type="hidden" name="ruleId" value={rule.id} />
          <div className="flex flex-wrap items-end gap-2">
            {rule.kind === "fixed" ? (
              <>
                <Field help="specialPrice" label={t("pricing.specialPriceField")} error={updateState.fieldErrors?.price}>
                  <Input name="price" defaultValue={values.price ?? rule.priceInput} inputMode="decimal" className="h-11 w-32 tabular-nums" />
                </Field>
                <Field label={t("pricing.fromQuantityPlain")} error={updateState.fieldErrors?.minQty}>
                  <Input name="minQty" defaultValue={values.minQty ?? rule.minQty} inputMode="decimal" className="h-11 w-28 tabular-nums" />
                </Field>
              </>
            ) : (
              <Field label={t("pricing.discountField")} error={updateState.fieldErrors?.percent}>
                <Input name="percent" defaultValue={values.percent ?? rule.percentInput} inputMode="decimal" className="h-11 w-28 tabular-nums" />
              </Field>
            )}
            <SubmitButton>{t("pricing.save")}</SubmitButton>
          </div>
          <ConfirmBelowCost show={Boolean(updateState.needsCostConfirm)} />
          <FormAlert error={updateState.fieldErrors ? undefined : updateState.error} />
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

type AddRuleProps = {
  customers: { id: string; name: string; typeLabel: string }[];
  /** A product page passes its product; the all-products form passes null (% off only). */
  product: { id: string; baseUnit: string } | null;
};

export function AddRuleForm({ customers, product }: AddRuleProps) {
  const t = useT();
  const [state, action] = useActionState<PricingFormState, FormData>(addRuleAction, {});
  const values = state.values ?? {};
  const [kind, setKind] = useState<"fixed" | "pct">(product ? ((values.kind as "fixed" | "pct") ?? "fixed") : "pct");

  if (customers.length === 0) {
    return <p className="border-t border-border pt-4 text-sm text-muted-foreground">{t("pricing.noCustomers")}</p>;
  }

  return (
    <form key={state.nonce ?? "add"} action={action} className="flex flex-col gap-3 border-t border-border pt-4">
      <input type="hidden" name="productId" value={product?.id ?? ""} />
      <input type="hidden" name="kind" value={kind} />
      {product ? (
        <div role="radiogroup" aria-label={t("pricing.ruleType")} className="inline-flex gap-1 self-start rounded-xl bg-muted p-1">
          {(["fixed", "pct"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={kind === option}
              onClick={() => setKind(option)}
              className={`inline-flex h-10 items-center rounded-lg px-4 text-sm font-semibold ${kind === option ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
            >
              {t(option === "fixed" ? "pricing.specialPrice" : "pricing.pctOff")}
            </button>
          ))}
        </div>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("common.customer.label")} error={state.fieldErrors?.customerId} className="sm:col-span-2">
          <FormSelect name="customerId" defaultValue={values.customerId ?? ""}>
            <option value="" disabled>
              {t("common.choose")}
            </option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name} ({customer.typeLabel})
              </option>
            ))}
          </FormSelect>
        </Field>
        {kind === "fixed" && product ? (
          <>
            <Field help="specialPrice" label={t("pricing.specialPricePer", { unit: unitShort(t, product.baseUnit) })} hint={t("pricing.specialHint")} error={state.fieldErrors?.price}>
              <Input name="price" defaultValue={values.price} inputMode="decimal" placeholder={t("pricing.exampleSpecial")} className="h-11 tabular-nums" />
            </Field>
            <Field label={t("pricing.fromQuantity", { unit: unitShort(t, product.baseUnit) })} hint={t("pricing.anyQtyHint")} error={state.fieldErrors?.minQty}>
              <Input name="minQty" defaultValue={values.minQty} inputMode="decimal" placeholder={t("pricing.exampleSlabQty")} className="h-11 tabular-nums" />
            </Field>
          </>
        ) : (
          <Field help="discount" label={t("pricing.discountField")} hint={t("pricing.discountHint")} error={state.fieldErrors?.percent}>
            <Input name="percent" defaultValue={values.percent} inputMode="decimal" placeholder={t("pricing.examplePct")} className="h-11 tabular-nums" />
          </Field>
        )}
      </div>
      <ConfirmBelowCost show={Boolean(state.needsCostConfirm)} />
      <FormAlert error={state.fieldErrors ? undefined : state.error} message={state.message} />
      <div>
        <SubmitButton variant="outline">{t("pricing.addRule")}</SubmitButton>
      </div>
    </form>
  );
}

export function RuleList({ rules, productId, emptyText }: { rules: RuleView[]; productId: string; emptyText: string }) {
  const t = useT();
  const editable = rules.filter((rule) => !rule.appliesToAll);
  const shared = rules.filter((rule) => rule.appliesToAll && rule.isActive);
  return (
    <div className="flex flex-col gap-3">
      {editable.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {[...editable.filter((rule) => rule.isActive), ...editable.filter((rule) => !rule.isActive)].map((rule) => (
            <RuleRow key={rule.id} rule={rule} productId={productId} />
          ))}
        </ul>
      )}
      {shared.length > 0 ? (
        <div className="rounded-xl bg-muted/60 px-4 py-3 text-sm">
          <p className="font-medium text-foreground">{t("pricing.alsoApplies")}</p>
          <ul className="mt-1 text-muted-foreground">
            {shared.map((rule) => (
              <li key={rule.id}>
                {rule.customerName}: {rule.summary}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-muted-foreground">{t("pricing.alsoAppliesHelp")}</p>
        </div>
      ) : null}
    </div>
  );
}
