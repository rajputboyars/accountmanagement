"use client";

import { useActionState, useState, useTransition } from "react";
import { Copy, MessageCircle } from "lucide-react";
import { logReminderAction, prepareReminderAction, recordReceiptAction, reverseReceiptAction, saveCustomerAction, type FormState } from "@/app/(app)/customers/actions";
import { Field, FormAlert, FormSelect, SubmitButton } from "@/components/catalog/form-bits";
import { useT } from "@/components/nexora/language-provider";
import { Button, buttonVariants } from "@/components/ui/button";
import { LANGUAGE_NAMES, LANGUAGES, type Language } from "@/shared/i18n/languages";
import { Input } from "@/components/ui/input";

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "") : `${Date.now()}${Math.random().toString(36).slice(2)}`);

type Customer = { id: string; name: string; phone: string | null; type: string; area: string | null; gstin: string | null; creditLimitPaise: number; whatsappConsent: boolean; communicationLanguage: Language | null };

export function CustomerForm({ customer }: { customer?: Customer }) {
  const t = useT();
  const [saved, setSaved] = useState(0);
  const [state, action] = useActionState<FormState, FormData>(async (previous, formData) => {
    const result = await saveCustomerAction(previous, formData);
    if (result.ok && !customer) setSaved((count) => count + 1);
    return result;
  }, {});
  const v = state.ok ? {} : (state.values ?? {});
  const e = state.fieldErrors ?? {};
  return (
    <form key={saved} action={action} className="flex flex-col gap-3">
      {customer ? <input type="hidden" name="customerId" value={customer.id} /> : null}
      <Field label={t("common.name")} error={e.name}>
        <Input name="name" defaultValue={v.name ?? customer?.name ?? ""} maxLength={120} className="h-11" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("common.phone")} error={e.phone}>
          <Input name="phone" defaultValue={v.phone ?? customer?.phone ?? ""} inputMode="tel" className="h-11" />
        </Field>
        <Field label={t("common.type")} error={e.type}>
          <FormSelect name="type" defaultValue={v.type ?? customer?.type ?? "retail"}>
            <option value="retail">{t("common.retail")}</option>
            <option value="wholesale">{t("common.wholesale")}</option>
          </FormSelect>
        </Field>
        <Field label={t("customers.area")} error={e.area}>
          <Input name="area" defaultValue={v.area ?? customer?.area ?? ""} className="h-11" />
        </Field>
        <Field help="creditLimit" label={t("customers.creditLimitField")} error={e.creditLimit}>
          <Input name="creditLimit" defaultValue={v.creditLimit ?? (customer ? String(customer.creditLimitPaise / 100) : "0")} inputMode="decimal" className="h-11 tabular-nums" />
        </Field>
      </div>
      <Field label={t("customers.gstinOptional")} error={e.gstin}>
        <Input name="gstin" defaultValue={v.gstin ?? customer?.gstin ?? ""} maxLength={15} className="h-11 uppercase" />
      </Field>
      <Field label={t("customers.messageLanguage")} hint={t("customers.messageLanguageHint")} error={e.communicationLanguage}>
        <FormSelect name="communicationLanguage" defaultValue={v.communicationLanguage ?? customer?.communicationLanguage ?? ""}>
          <option value="">{t("customers.languageNotSet")}</option>
          {LANGUAGES.map((option) => (
            <option key={option} value={option}>
              {LANGUAGE_NAMES[option]}
            </option>
          ))}
        </FormSelect>
      </Field>
      {customer ? null : (
        <div className="grid grid-cols-2 gap-3 rounded-xl bg-muted/50 p-3">
          <p className="col-span-2 text-xs text-muted-foreground">{t("customers.goLiveHelp")}</p>
          <Field label={t("customers.owesYouField")} error={e.openingOwed}>
            <Input name="openingOwed" defaultValue={v.openingOwed} inputMode="decimal" className="h-11 tabular-nums" />
          </Field>
          <Field label={t("customers.oldestUnpaid")} error={e.oldestBillDate}>
            <Input type="date" name="oldestBillDate" defaultValue={v.oldestBillDate} className="h-11" />
          </Field>
          <Field label={t("customers.advanceField")} error={e.openingAdvance}>
            <Input name="openingAdvance" defaultValue={v.openingAdvance} inputMode="decimal" className="h-11 tabular-nums" />
          </Field>
        </div>
      )}
      <label className="flex min-h-11 items-start gap-2 text-sm text-foreground">
        <input type="checkbox" name="whatsappConsent" defaultChecked={v.whatsappConsent ? v.whatsappConsent === "on" : customer?.whatsappConsent} className="mt-0.5 size-5 accent-[var(--teal-strong)]" />
        {t("customers.consent")}
      </label>
      <FormAlert error={state.fieldErrors ? undefined : state.error} message={state.message} />
      <div>
        <SubmitButton variant={customer ? "outline" : "default"}>{t(customer ? "common.saveDetails" : "customers.addButton")}</SubmitButton>
      </div>
    </form>
  );
}

export function ReceiptForm({ customerId, balanceText }: { customerId: string; balanceText: string }) {
  const t = useT();
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);
  const [state, action] = useActionState<FormState, FormData>(async (previous, formData) => {
    const result = await recordReceiptAction(previous, formData);
    if (result.ok) setIdempotencyKey(newKey());
    return result;
  }, {});
  const v = state.ok ? {} : (state.values ?? {});
  const e = state.fieldErrors ?? {};
  return (
    <form key={idempotencyKey} action={action} className="flex flex-col gap-3">
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("common.amountRupees")} hint={t("customers.balanceHint", { amount: balanceText })} error={e.amount}>
          <Input name="amount" defaultValue={v.amount} inputMode="decimal" className="h-11 tabular-nums" />
        </Field>
        <Field label={t("common.paidBy")} error={e.method}>
          <FormSelect name="method" defaultValue={v.method ?? "cash"}>
            <option value="cash">{t("common.cash")}</option>
            <option value="upi">{t("common.upi")}</option>
            <option value="bank">{t("suppliers.bankTransfer")}</option>
            <option value="cheque">{t("common.cheque")}</option>
          </FormSelect>
        </Field>
      </div>
      <Field label={t("customers.reference")} error={e.reference}>
        <Input name="reference" defaultValue={v.reference} maxLength={40} className="h-11" />
      </Field>
      <FormAlert error={state.fieldErrors ? undefined : state.error} message={state.message} />
      <div>
        <SubmitButton>{t("common.recordPayment")}</SubmitButton>
      </div>
    </form>
  );
}

export function ReverseReceipt({ customerId, paymentId }: { customerId: string; paymentId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState<FormState, FormData>(reverseReceiptAction, {});
  if (state.ok) return <span className="text-xs text-muted-foreground">{t("customers.reversed")}</span>;
  if (!open) {
    return (
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>
        {t("common.reverse")}
      </Button>
    );
  }
  return (
    <form action={action} className="flex w-full flex-wrap items-end gap-2">
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="paymentId" value={paymentId} />
      <Field label={t("customers.whyReverse")} error={state.error} className="flex-1">
        <Input name="reason" maxLength={200} className="h-11" />
      </Field>
      <SubmitButton variant="destructive">{t("common.reverse")}</SubmitButton>
      <Button type="button" variant="ghost" size="touch" onClick={() => setOpen(false)}>
        {t("common.keep")}
      </Button>
    </form>
  );
}

/** Builds the reminder on the server; the person sends it. Never shows "sent" without a provider. */
export function ReminderCard({ customerId }: { customerId: string }) {
  const t = useT();
  const [pending, start] = useTransition();
  const [reminder, setReminder] = useState<{ text: string; phone: string; providerConfigured: boolean } | null>(null);
  // The person can reword the message before sharing it; the amounts come from the server.
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const shared = (how: "customers.copied" | "customers.openedWhatsapp") =>
    start(async () => {
      const result = await logReminderAction(customerId, "shared");
      setNote("error" in result ? (result.error ?? null) : t(how));
    });
  return (
    <div className="flex flex-col gap-3">
      {reminder ? (
        <>
          <label className="flex flex-col gap-1 text-sm font-medium text-foreground">
            {t("customers.checkMessage")}
            <textarea value={text} onChange={(event) => setText(event.target.value)} rows={9} className="rounded-xl border border-input bg-background p-3 text-sm font-normal" />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="touch" disabled={pending} onClick={() => navigator.clipboard.writeText(text).then(() => shared("customers.copied"))}>
              <Copy aria-hidden="true" />
              {t("share.copy")}
            </Button>
            <a href={`https://wa.me/91${reminder.phone}?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer" onClick={() => shared("customers.openedWhatsapp")} className={buttonVariants({ size: "touch" })}>
              <MessageCircle className="size-4" aria-hidden="true" />
              {t("customers.openWhatsapp")}
            </a>
          </div>
          {reminder.providerConfigured ? (
            <Button
              type="button"
              size="touch"
              className="self-start"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const result = await logReminderAction(customerId, "provider");
                  setNote("error" in result ? (result.error ?? null) : t(result.duplicate ? "customers.alreadyQueued" : "customers.queuedNote"));
                })
              }
            >
              <MessageCircle className="size-4" aria-hidden="true" />
              {t("customers.sendViaWhatsapp")}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">{t("customers.noService")}</p>
          )}
        </>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="touch"
          className="self-start"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const result = await prepareReminderAction(customerId);
              if ("reminder" in result && result.reminder) {
                setReminder(result.reminder);
                setText(result.reminder.text);
              }
              else setNote(result.error ?? t("customers.reminderFailed"));
            })
          }
        >
          {t("customers.prepareReminder")}
        </Button>
      )}
      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
    </div>
  );
}
