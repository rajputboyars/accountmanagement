"use client";

import { useActionState, useState } from "react";
import { paySupplierAction, reversalAction, saveSupplierAction, type FormResult } from "@/app/(app)/purchases/actions";
import { Field, FormAlert, FormSelect, SubmitButton } from "@/components/catalog/form-bits";
import { useT } from "@/components/nexora/language-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "") : `${Date.now()}${Math.random().toString(36).slice(2)}`);

export function SupplierForm({ supplier }: { supplier?: { id: string; name: string; phone: string | null; gstin: string | null; paymentTermsDays: number } }) {
  const t = useT();
  const [saved, setSaved] = useState(0);
  const [state, action] = useActionState<FormResult, FormData>(async (previous, formData) => {
    const result = await saveSupplierAction(previous, formData);
    // A fresh form after adding a supplier; the edit form keeps showing the saved values.
    if (result.ok && !supplier) setSaved((count) => count + 1);
    return result;
  }, {});
  const values = state.ok ? {} : (state.values ?? {});
  const errors = state.fieldErrors ?? {};
  return (
    <form key={saved} action={action} className="flex flex-col gap-3">
      {supplier ? <input type="hidden" name="supplierId" value={supplier.id} /> : null}
      <Field label={t("common.name")} error={errors.name}>
        <Input name="name" defaultValue={values.name ?? supplier?.name ?? ""} maxLength={120} placeholder={t("suppliers.namePlaceholder")} className="h-11" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={<span>{t("common.phone")} <span className="font-normal text-muted-foreground">{t("common.optional")}</span></span>} error={errors.phone}>
          <Input name="phone" defaultValue={values.phone ?? supplier?.phone ?? ""} inputMode="tel" className="h-11" />
        </Field>
        <Field label={t("suppliers.terms")} error={errors.paymentTermsDays}>
          <Input name="paymentTermsDays" defaultValue={values.paymentTermsDays ?? String(supplier?.paymentTermsDays ?? 30)} inputMode="numeric" className="h-11 tabular-nums" />
        </Field>
      </div>
      <Field label={<span>GSTIN <span className="font-normal text-muted-foreground">{t("common.optional")}</span></span>} error={errors.gstin}>
        <Input name="gstin" defaultValue={values.gstin ?? supplier?.gstin ?? ""} maxLength={15} className="h-11 uppercase" />
      </Field>
      <FormAlert error={state.fieldErrors ? undefined : state.error} message={state.message} />
      <div>
        <SubmitButton variant={supplier ? "outline" : "default"}>{t(supplier ? "common.saveDetails" : "suppliers.addButton")}</SubmitButton>
      </div>
    </form>
  );
}

export function PaySupplierForm({ supplierId, owedText }: { supplierId: string; owedText: string }) {
  const t = useT();
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);
  const [state, action] = useActionState<FormResult, FormData>(async (previous, formData) => {
    const result = await paySupplierAction(previous, formData);
    if (result.ok) setIdempotencyKey(newKey());
    return result;
  }, {});
  const values = state.ok ? {} : (state.values ?? {});
  const errors = state.fieldErrors ?? {};
  return (
    <form key={state.ok ? idempotencyKey : "pay"} action={action} className="flex flex-col gap-3">
      <input type="hidden" name="supplierId" value={supplierId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("common.amountRupees")} hint={t("suppliers.oweHint", { amount: owedText })} error={errors.amount}>
          <Input name="amount" defaultValue={values.amount} inputMode="decimal" placeholder={t("suppliers.amountPlaceholder")} className="h-11 tabular-nums" />
        </Field>
        <Field label={t("common.paidBy")} error={errors.method}>
          <FormSelect name="method" defaultValue={values.method ?? "bank"}>
            <option value="cash">{t("common.cash")}</option>
            <option value="upi">{t("common.upi")}</option>
            <option value="bank">{t("suppliers.bankTransfer")}</option>
            <option value="cheque">{t("common.cheque")}</option>
          </FormSelect>
        </Field>
      </div>
      <Field label={<span>{t("suppliers.reference")} <span className="font-normal text-muted-foreground">{t("suppliers.referenceHint")}</span></span>} error={errors.reference}>
        <Input name="reference" defaultValue={values.reference} maxLength={40} className="h-11" />
      </Field>
      <FormAlert error={state.fieldErrors ? undefined : state.error} message={state.message} />
      <div>
        <SubmitButton>{t("common.recordPayment")}</SubmitButton>
      </div>
    </form>
  );
}

/** "Are you sure? Give a reason" for cancelling a receipt or order, closing a shortfall or reversing a payment. */
export function ReversalButton({ kind, targetId, label, confirmLabel, question, refreshPath = "" }: { kind: "receipt" | "order-cancel" | "order-close" | "payment"; targetId: string; label: string; confirmLabel: string; question: string; refreshPath?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState<FormResult, FormData>(reversalAction, {});
  if (state.ok) return <FormAlert message={t("suppliers.done")} />;
  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }
  return (
    <form action={action} className="flex w-full flex-col gap-2 rounded-xl border border-border bg-muted/50 p-3">
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="targetId" value={targetId} />
      <input type="hidden" name="refreshPath" value={refreshPath} />
      <p className="text-sm text-foreground">{question}</p>
      <Field label={t("common.reason")} error={state.error}>
        <Input name="reason" maxLength={200} className="h-11" />
      </Field>
      <div className="flex flex-wrap gap-2">
        <SubmitButton variant="destructive">{confirmLabel}</SubmitButton>
        <Button type="button" variant="ghost" size="touch" onClick={() => setOpen(false)}>
          {t("suppliers.keepIt")}
        </Button>
      </div>
    </form>
  );
}
