"use client";

import { useActionState, useState } from "react";
import { Field, FormAlert, FormSelect, SubmitButton } from "@/components/catalog/form-bits";
import { Input } from "@/components/ui/input";
import type { BusinessSettings } from "@/modules/settings";
import { COMPOSITION_DECLARATION, GST_STATE_LIST, STATUTORY_GST_RATES_BP } from "@/shared/gst";
import { saveGstAction, saveInvoiceAction, saveProfileAction, type SettingsFormState } from "./actions";

const selectClass = "h-11 rounded-lg border border-input bg-background px-3 text-sm text-foreground";
const textareaClass = "min-h-20 rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground";
const pick = (state: SettingsFormState, name: string, saved: string | null) => (typeof state.values?.[name] === "string" ? (state.values[name] as string) : (saved ?? ""));
const rateLabel = (rate: number) => (rate === 0 ? "0% (nil / exempt)" : `${(rate / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`);

export function ProfileForm({ profile }: { profile: BusinessSettings["profile"] }) {
  const [state, action] = useActionState<SettingsFormState, FormData>(saveProfileAction, {});
  return (
    <form key={state.nonce ?? "profile"} action={action} className="grid gap-4 sm:grid-cols-2">
      <Field label="Shop name (on screen and bills)">
        <Input name="name" required defaultValue={pick(state, "name", profile.name)} className="h-11" />
      </Field>
      <Field label="Legal name" hint="As registered for GST, if different.">
        <Input name="legalName" defaultValue={pick(state, "legalName", profile.legalName)} className="h-11" />
      </Field>
      <Field label="Address" className="sm:col-span-2">
        <textarea name="address" maxLength={300} defaultValue={pick(state, "address", profile.address)} className={textareaClass} />
      </Field>
      <Field label="Phone">
        <Input name="phone" inputMode="tel" defaultValue={pick(state, "phone", profile.phone)} className="h-11" />
      </Field>
      <Field label="State" hint="Decides CGST + SGST versus IGST. Must match the GSTIN.">
        <FormSelect name="stateCode" defaultValue={pick(state, "stateCode", profile.stateCode)} className={selectClass}>
          {GST_STATE_LIST.map(([code, name]) => (
            <option key={code} value={code}>
              {code} · {name}
            </option>
          ))}
        </FormSelect>
      </Field>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <SubmitButton>Save details</SubmitButton>
        <FormAlert error={state.error} message={state.message} />
      </div>
    </form>
  );
}

export function GstForm({ gst }: { gst: BusinessSettings["gst"] }) {
  const [state, action] = useActionState<SettingsFormState, FormData>(saveGstAction, {});
  const savedRates = Array.isArray(state.values?.gstRatesBp) ? (state.values.gstRatesBp as string[]).map(Number) : gst.gstRatesBp;
  const [registration, setRegistration] = useState(pick(state, "registration", gst.registration));
  return (
    <form key={state.nonce ?? "gst"} action={action} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="GST registration">
          <select name="registration" value={registration} onChange={(event) => setRegistration(event.target.value)} className={selectClass}>
            <option value="regular">Regular (charges GST, Tax Invoice)</option>
            <option value="composition">Composition scheme (no GST on bills, Bill of Supply)</option>
            <option value="unregistered">Not registered (no GST on bills, Bill of Supply)</option>
          </select>
        </Field>
        <Field label="GSTIN" hint={registration === "unregistered" ? "Leave empty when not registered." : "15 characters; checked for typing mistakes."}>
          <Input name="gstin" maxLength={15} disabled={registration === "unregistered"} defaultValue={registration === "unregistered" ? "" : pick(state, "gstin", gst.gstin)} className="h-11 uppercase" />
        </Field>
      </div>
      {registration === "composition" ? <p className="rounded-xl bg-amber-soft px-4 py-3 text-sm text-amber-ink">Bills will say: “{COMPOSITION_DECLARATION}”</p> : null}
      {registration === "regular" ? (
        <label className="flex items-start gap-3 text-sm text-foreground">
          <input type="checkbox" name="interStateSales" defaultChecked={state.values ? state.values.interStateSales === "on" : gst.interStateSales} className="mt-1 size-4" />
          <span>
            <span className="font-medium">Allow inter-state sales (IGST)</span>
            <span className="block text-muted-foreground">Billing then lets you choose another state as the place of supply when goods are delivered there. Counter sales stay CGST + SGST. Ask your CA if unsure.</span>
          </span>
        </label>
      ) : null}
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-foreground">GST rates you use on products</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {STATUTORY_GST_RATES_BP.map((rate) => (
            <label key={rate} className="inline-flex min-h-10 items-center gap-2 text-sm text-foreground">
              <input type="checkbox" name="gstRatesBp" value={rate} defaultChecked={savedRates.includes(rate)} className="size-4" />
              {rateLabel(rate)}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Each product&apos;s rate must come from its HSN code; this list only limits what the product form offers.</p>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton>Save GST settings</SubmitButton>
        <FormAlert error={state.error} message={state.message} />
      </div>
    </form>
  );
}

export function InvoiceForm({ invoice }: { invoice: BusinessSettings["invoice"] }) {
  const [state, action] = useActionState<SettingsFormState, FormData>(saveInvoiceAction, {});
  return (
    <form key={state.nonce ?? "invoice"} action={action} className="grid gap-4 sm:grid-cols-2">
      <Field label="Invoice prefix" hint={invoice.numberingStarted ? `Fixed for ${invoice.fy}: bills are already numbered.` : "1 to 4 letters."}>
        <Input name="invoicePrefix" maxLength={4} readOnly={invoice.numberingStarted} defaultValue={pick(state, "invoicePrefix", invoice.invoicePrefix)} className="h-11 uppercase" />
      </Field>
      <Field label={`Next bill number for ${invoice.fy}`} hint={invoice.numberingStarted ? `Next bill: ${invoice.sample}` : `First bill will be ${invoice.sample}. Change only if continuing from another system.`}>
        <Input name="startingNumber" inputMode="numeric" readOnly={invoice.numberingStarted} defaultValue={pick(state, "startingNumber", String(invoice.nextNumber))} className="h-11" />
      </Field>
      <Field label="UPI id for payments" hint="Printed on bills, e.g. shopname@okhdfcbank.">
        <Input name="upiId" defaultValue={pick(state, "upiId", invoice.upiId)} className="h-11" />
      </Field>
      <Field label="Bank details">
        <Input name="bankDetails" maxLength={300} placeholder="A/c no. · IFSC · Bank" defaultValue={pick(state, "bankDetails", invoice.bankDetails)} className="h-11" />
      </Field>
      <Field label="Terms printed on bills" className="sm:col-span-2">
        <textarea name="terms" maxLength={500} placeholder="Goods once sold will be exchanged only with the bill within 7 days." defaultValue={pick(state, "terms", invoice.terms)} className={textareaClass} />
      </Field>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <SubmitButton>Save invoice settings</SubmitButton>
        <FormAlert error={state.error} message={state.message} />
      </div>
    </form>
  );
}
