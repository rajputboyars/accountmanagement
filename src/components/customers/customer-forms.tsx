"use client";

import { useActionState, useState, useTransition } from "react";
import { Copy, MessageCircle } from "lucide-react";
import { logReminderAction, prepareReminderAction, recordReceiptAction, reverseReceiptAction, saveCustomerAction, type FormState } from "@/app/(app)/customers/actions";
import { Field, FormAlert, FormSelect, SubmitButton } from "@/components/catalog/form-bits";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "") : `${Date.now()}${Math.random().toString(36).slice(2)}`);

type Customer = { id: string; name: string; phone: string | null; type: string; area: string | null; gstin: string | null; creditLimitPaise: number; whatsappConsent: boolean };

export function CustomerForm({ customer }: { customer?: Customer }) {
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
      <Field label="Name" error={e.name}>
        <Input name="name" defaultValue={v.name ?? customer?.name ?? ""} maxLength={120} className="h-11" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Phone" error={e.phone}>
          <Input name="phone" defaultValue={v.phone ?? customer?.phone ?? ""} inputMode="tel" className="h-11" />
        </Field>
        <Field label="Type" error={e.type}>
          <FormSelect name="type" defaultValue={v.type ?? customer?.type ?? "retail"}>
            <option value="retail">Retail</option>
            <option value="wholesale">Wholesale</option>
          </FormSelect>
        </Field>
        <Field label="Area (optional)" error={e.area}>
          <Input name="area" defaultValue={v.area ?? customer?.area ?? ""} className="h-11" />
        </Field>
        <Field label="Credit limit (₹)" error={e.creditLimit}>
          <Input name="creditLimit" defaultValue={v.creditLimit ?? (customer ? String(customer.creditLimitPaise / 100) : "0")} inputMode="decimal" className="h-11 tabular-nums" />
        </Field>
      </div>
      <Field label="GSTIN (optional)" error={e.gstin}>
        <Input name="gstin" defaultValue={v.gstin ?? customer?.gstin ?? ""} maxLength={15} className="h-11 uppercase" />
      </Field>
      {customer ? null : (
        <div className="grid grid-cols-2 gap-3 rounded-xl bg-muted/50 p-3">
          <p className="col-span-2 text-xs text-muted-foreground">At go-live only: what they already owe (or paid ahead), dated the oldest unpaid bill.</p>
          <Field label="Owes you (₹)" error={e.openingOwed}>
            <Input name="openingOwed" defaultValue={v.openingOwed} inputMode="decimal" className="h-11 tabular-nums" />
          </Field>
          <Field label="Oldest unpaid bill" error={e.oldestBillDate}>
            <Input type="date" name="oldestBillDate" defaultValue={v.oldestBillDate} className="h-11" />
          </Field>
          <Field label="Or advance paid (₹)" error={e.openingAdvance}>
            <Input name="openingAdvance" defaultValue={v.openingAdvance} inputMode="decimal" className="h-11 tabular-nums" />
          </Field>
        </div>
      )}
      <label className="flex min-h-11 items-start gap-2 text-sm text-foreground">
        <input type="checkbox" name="whatsappConsent" defaultChecked={v.whatsappConsent ? v.whatsappConsent === "on" : customer?.whatsappConsent} className="mt-0.5 size-5 accent-[var(--teal-strong)]" />
        The customer agreed to payment reminders on WhatsApp
      </label>
      <FormAlert error={state.fieldErrors ? undefined : state.error} message={state.message} />
      <div>
        <SubmitButton variant={customer ? "outline" : "default"}>{customer ? "Save details" : "Add customer"}</SubmitButton>
      </div>
    </form>
  );
}

export function ReceiptForm({ customerId, balanceText }: { customerId: string; balanceText: string }) {
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
        <Field label="Amount (₹)" hint={`Balance ${balanceText}. More becomes an advance.`} error={e.amount}>
          <Input name="amount" defaultValue={v.amount} inputMode="decimal" className="h-11 tabular-nums" />
        </Field>
        <Field label="Paid by" error={e.method}>
          <FormSelect name="method" defaultValue={v.method ?? "cash"}>
            <option value="cash">Cash</option>
            <option value="upi">UPI</option>
            <option value="bank">Bank</option>
            <option value="cheque">Cheque</option>
          </FormSelect>
        </Field>
      </div>
      <Field label="Reference (UTR / cheque no.)" error={e.reference}>
        <Input name="reference" defaultValue={v.reference} maxLength={40} className="h-11" />
      </Field>
      <FormAlert error={state.fieldErrors ? undefined : state.error} message={state.message} />
      <div>
        <SubmitButton>Record payment</SubmitButton>
      </div>
    </form>
  );
}

export function ReverseReceipt({ customerId, paymentId }: { customerId: string; paymentId: string }) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState<FormState, FormData>(reverseReceiptAction, {});
  if (state.ok) return <span className="text-xs text-muted-foreground">Reversed</span>;
  if (!open) {
    return (
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Reverse
      </Button>
    );
  }
  return (
    <form action={action} className="flex w-full flex-wrap items-end gap-2">
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="paymentId" value={paymentId} />
      <Field label="Why reverse it?" error={state.error} className="flex-1">
        <Input name="reason" maxLength={200} className="h-11" />
      </Field>
      <SubmitButton variant="destructive">Reverse</SubmitButton>
      <Button type="button" variant="ghost" size="touch" onClick={() => setOpen(false)}>
        Keep
      </Button>
    </form>
  );
}

/** Builds the reminder on the server; the person sends it. Never shows "sent" without a provider. */
export function ReminderCard({ customerId }: { customerId: string }) {
  const [pending, start] = useTransition();
  const [reminder, setReminder] = useState<{ text: string; shareUrl: string; providerConfigured: boolean } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const shared = (how: string) =>
    start(async () => {
      const result = await logReminderAction(customerId, "shared");
      setNote("error" in result ? (result.error ?? null) : `${how}. Delivery isn't confirmed: check WhatsApp.`);
    });
  return (
    <div className="flex flex-col gap-3">
      {reminder ? (
        <>
          <pre className="rounded-xl bg-muted/60 p-3 text-sm whitespace-pre-wrap text-foreground">{reminder.text}</pre>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="touch" disabled={pending} onClick={() => navigator.clipboard.writeText(reminder.text).then(() => shared("Copied"))}>
              <Copy aria-hidden="true" />
              Copy text
            </Button>
            <a href={reminder.shareUrl} target="_blank" rel="noreferrer" onClick={() => shared("Opened WhatsApp")} className={buttonVariants({ size: "touch" })}>
              <MessageCircle className="size-4" aria-hidden="true" />
              Open WhatsApp
            </a>
          </div>
          {!reminder.providerConfigured ? <p className="text-xs text-muted-foreground">No WhatsApp sending service is set up, so you send it yourself.</p> : null}
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
              if ("reminder" in result && result.reminder) setReminder(result.reminder);
              else setNote(result.error ?? "Couldn't prepare the reminder.");
            })
          }
        >
          Prepare reminder
        </Button>
      )}
      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
    </div>
  );
}
