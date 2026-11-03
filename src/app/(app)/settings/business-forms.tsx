"use client";

import { ChevronDown } from "lucide-react";
import { useActionState, useState } from "react";
import { Field, FormAlert, FormSelect, SubmitButton } from "@/components/catalog/form-bits";
import { useT } from "@/components/nexora/language-provider";
import { Input } from "@/components/ui/input";
import type { BusinessSettings } from "@/modules/settings";
import { COMPOSITION_DECLARATION, GST_STATE_LIST, STATUTORY_GST_RATES_BP } from "@/shared/gst";
import type { MessageKey } from "@/shared/i18n/messages/en";
import { saveGstAction, saveInvoiceAction, saveProfileAction, type SettingsFormState } from "./actions";

const REGISTRATION_KEYS = { regular: "settings.regRegular", composition: "settings.regComposition", unregistered: "settings.regNone" } as const;
const selectClass = "h-11 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm text-foreground";
const textareaClass = "min-h-20 rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground";
const pick = (state: SettingsFormState, name: string, saved: string | null) => (typeof state.values?.[name] === "string" ? (state.values[name] as string) : (saved ?? ""));

export function ProfileForm({ profile }: { profile: BusinessSettings["profile"] }) {
  const t = useT();
  const [state, action] = useActionState<SettingsFormState, FormData>(saveProfileAction, {});
  return (
    <form key={state.nonce ?? "profile"} action={action} className="grid gap-4 sm:grid-cols-2">
      <Field label={t("settings.shopName")}>
        <Input name="name" required defaultValue={pick(state, "name", profile.name)} className="h-11" />
      </Field>
      <Field label={t("settings.legalName")} hint={t("settings.legalNameHint")}>
        <Input name="legalName" defaultValue={pick(state, "legalName", profile.legalName)} className="h-11" />
      </Field>
      <Field label={t("settings.address")} className="sm:col-span-2">
        <textarea name="address" maxLength={300} defaultValue={pick(state, "address", profile.address)} className={textareaClass} />
      </Field>
      <Field label={t("common.phone")}>
        <Input name="phone" inputMode="tel" defaultValue={pick(state, "phone", profile.phone)} className="h-11" />
      </Field>
      <Field label={t("settings.pinCode")} hint={t("settings.pinCodeHint")}>
        <Input name="pinCode" inputMode="numeric" maxLength={6} defaultValue={pick(state, "pinCode", profile.pinCode)} className="h-11" />
      </Field>
      <Field label={t("settings.email")} hint={t("settings.emailHint")}>
        <Input name="email" type="email" inputMode="email" defaultValue={pick(state, "email", profile.email)} className="h-11" />
      </Field>
      <Field label={t("settings.state")} hint={t("settings.stateHint")}>
        <FormSelect name="stateCode" defaultValue={pick(state, "stateCode", profile.stateCode)} className={selectClass}>
          {GST_STATE_LIST.map(([code]) => (
            <option key={code} value={code}>
              {code} · {t(`state.${code}` as MessageKey)}
            </option>
          ))}
        </FormSelect>
      </Field>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <SubmitButton>{t("common.saveDetails")}</SubmitButton>
        <FormAlert error={state.error} message={state.message} />
      </div>
    </form>
  );
}

export function GstForm({ gst }: { gst: BusinessSettings["gst"] }) {
  const t = useT();
  const rateLabel = (rate: number) => (rate === 0 ? t("settings.rateNil") : `${(rate / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`);
  const [state, action] = useActionState<SettingsFormState, FormData>(saveGstAction, {});
  const savedRates = Array.isArray(state.values?.gstRatesBp) ? (state.values.gstRatesBp as string[]).map(Number) : gst.gstRatesBp;
  const [registration, setRegistration] = useState(pick(state, "registration", gst.registration));
  return (
    <form key={state.nonce ?? "gst"} action={action} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("settings.gstRegistration")}>
          {/* A closed native select cuts long text, so the chosen option shows in a box that can wrap. The select still does the work. */}
          <span className="relative flex min-h-11 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring">
            <span>{t(REGISTRATION_KEYS[registration as keyof typeof REGISTRATION_KEYS] ?? "settings.regRegular")}</span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <select name="registration" value={registration} onChange={(event) => setRegistration(event.target.value)} className="absolute inset-0 size-full cursor-pointer opacity-0">
              <option value="regular">{t("settings.regRegular")}</option>
              <option value="composition">{t("settings.regComposition")}</option>
              <option value="unregistered">{t("settings.regNone")}</option>
            </select>
          </span>
        </Field>
        <Field label="GSTIN" hint={t(registration === "unregistered" ? "settings.gstinEmpty" : "settings.gstinHint")}>
          <Input name="gstin" maxLength={15} disabled={registration === "unregistered"} defaultValue={registration === "unregistered" ? "" : pick(state, "gstin", gst.gstin)} className="h-11 uppercase" />
        </Field>
      </div>
      {registration === "composition" ? <p className="rounded-xl bg-amber-soft px-4 py-3 text-sm text-amber-ink">{t("settings.billsWillSay", { text: COMPOSITION_DECLARATION })} {t("settings.declarationNote")}</p> : null}
      {registration === "regular" ? (
        <label className="flex items-start gap-3 text-sm text-foreground">
          <input type="checkbox" name="interStateSales" defaultChecked={state.values ? state.values.interStateSales === "on" : gst.interStateSales} className="mt-1 size-4" />
          <span>
            <span className="font-medium">{t("settings.interState")}</span>
            <span className="block text-muted-foreground">{t("settings.interStateHelp")}</span>
          </span>
        </label>
      ) : null}
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-foreground">{t("settings.ratesLegend")}</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {STATUTORY_GST_RATES_BP.map((rate) => (
            <label key={rate} className="inline-flex min-h-10 items-center gap-2 text-sm text-foreground">
              <input type="checkbox" name="gstRatesBp" value={rate} defaultChecked={savedRates.includes(rate)} className="size-4" />
              {rateLabel(rate)}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t("settings.ratesHelp")}</p>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton>{t("settings.saveGst")}</SubmitButton>
        <FormAlert error={state.error} message={state.message} />
      </div>
    </form>
  );
}

export function InvoiceForm({ invoice }: { invoice: BusinessSettings["invoice"] }) {
  const t = useT();
  const [state, action] = useActionState<SettingsFormState, FormData>(saveInvoiceAction, {});
  return (
    <form key={state.nonce ?? "invoice"} action={action} className="grid gap-4 sm:grid-cols-2">
      <Field label={t("settings.prefix")} hint={invoice.numberingStarted ? t("settings.prefixFixed", { fy: invoice.fy }) : t("settings.prefixHint")}>
        <Input name="invoicePrefix" maxLength={4} readOnly={invoice.numberingStarted} defaultValue={pick(state, "invoicePrefix", invoice.invoicePrefix)} className="h-11 uppercase" />
      </Field>
      <Field label={t("settings.nextNumber", { fy: invoice.fy })} hint={t(invoice.numberingStarted ? "settings.nextBill" : "settings.firstBill", { sample: invoice.sample })}>
        <Input name="startingNumber" inputMode="numeric" readOnly={invoice.numberingStarted} defaultValue={pick(state, "startingNumber", String(invoice.nextNumber))} className="h-11" />
      </Field>
      <Field label={t("settings.upi")} hint={t("settings.upiHint")}>
        <Input name="upiId" defaultValue={pick(state, "upiId", invoice.upiId)} className="h-11" />
      </Field>
      <Field label={t("settings.bank")}>
        <Input name="bankDetails" maxLength={300} placeholder={t("settings.bankPlaceholder")} defaultValue={pick(state, "bankDetails", invoice.bankDetails)} className="h-11" />
      </Field>
      <Field label={t("settings.terms")} className="sm:col-span-2">
        <textarea name="terms" maxLength={500} placeholder={t("settings.termsPlaceholder")} defaultValue={pick(state, "terms", invoice.terms)} className={textareaClass} />
      </Field>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <SubmitButton>{t("settings.saveInvoice")}</SubmitButton>
        <FormAlert error={state.error} message={state.message} />
      </div>
    </form>
  );
}
