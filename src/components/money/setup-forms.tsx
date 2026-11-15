"use client";

import { useActionState, useTransition } from "react";
import { LoaderCircle } from "lucide-react";
import { activateAction, completeOpeningAction, confirmOpeningAction, setGstPolicyAction, type MoneyResult } from "@/app/(app)/reports/money/actions";
import { Field, FormAlert, FormSelect, SubmitButton } from "@/components/catalog/form-bits";
import { useT } from "@/components/nexora/language-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Step 1: the day the books start. */
export function ActivateForm({ maxDate, defaultDate }: { maxDate: string; defaultDate: string }) {
  const t = useT();
  const [state, action] = useActionState<MoneyResult, FormData>(activateAction, {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <Field label={t("money.setup.startDate")} hint={`${t("money.setup.step1.help")} ${t("money.setup.earliest", { date: defaultDate })}`} error={state.fieldErrors?.coverageStartDate}>
        <Input type="date" name="coverageStartDate" required max={maxDate} defaultValue={defaultDate} className="h-11 sm:max-w-56" />
      </Field>
      <FormAlert error={state.error} message={state.ok ? state.message : undefined} />
      <SubmitButton className="self-start">{t("money.setup.activate")}</SubmitButton>
    </form>
  );
}

const PLACEHOLDER = "0";

/** Step 2: what cannot be derived. Cash is prefilled when the day before the start was closed. */
export function OpeningForm({ suggestedCash, cashCountedOn }: { suggestedCash: number | null; cashCountedOn: string | null }) {
  const t = useT();
  const [state, action] = useActionState<MoneyResult, FormData>(completeOpeningAction, {});
  const rupees = (paise: number) => (paise / 100).toFixed(2).replace(/\.00$/, "");
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("money.setup.cashLabel")} hint={suggestedCash !== null && cashCountedOn ? t("money.setup.cashCounted", { date: cashCountedOn }) : t("money.setup.cashCount")} error={state.fieldErrors?.cash}>
          <Input name="cash" inputMode="decimal" defaultValue={suggestedCash !== null ? rupees(suggestedCash) : ""} placeholder={PLACEHOLDER} className="h-11 tabular-nums" />
        </Field>
        <Field label={t("money.setup.bankLabel")} error={state.fieldErrors?.bank}>
          <Input name="bank" inputMode="decimal" placeholder={PLACEHOLDER} className="h-11 tabular-nums" />
        </Field>
        <Field label={t("money.setup.upiLabel")} error={state.fieldErrors?.upi}>
          <Input name="upi" inputMode="decimal" placeholder={PLACEHOLDER} className="h-11 tabular-nums" />
        </Field>
        <Field label={t("money.setup.cardLabel")} error={state.fieldErrors?.card}>
          <Input name="card" inputMode="decimal" placeholder={PLACEHOLDER} className="h-11 tabular-nums" />
        </Field>
        <Field label={t("money.setup.chequesLabel")} error={state.fieldErrors?.cheques}>
          <Input name="cheques" inputMode="decimal" placeholder={PLACEHOLDER} className="h-11 tabular-nums" />
        </Field>
      </div>
      <FormAlert error={state.error} message={state.ok ? state.message : undefined} />
      <SubmitButton className="self-start">{t("money.setup.save")}</SubmitButton>
    </form>
  );
}

/** Step 3: the owner's confirmation. */
export function ConfirmButton() {
  const t = useT();
  const [pending, start] = useTransition();
  const [state, run] = useActionState<MoneyResult, void>(async () => confirmOpeningAction(), {});
  return (
    <div className="flex flex-col gap-3">
      <FormAlert error={state.error} message={state.ok ? state.message : undefined} />
      <Button type="button" size="touch" className="self-start" disabled={pending} onClick={() => start(() => run())}>
        {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
        {t("money.setup.confirm")}
      </Button>
    </div>
  );
}

/** Where GST paid on purchases goes. The default decides nothing. */
export function GstPolicyForm({ current }: { current: "review" | "recoverable" | "non_recoverable" }) {
  const t = useT();
  const [state, action] = useActionState<MoneyResult, FormData>(setGstPolicyAction, {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <Field label={t("money.gst.title")} hint={t("money.gst.help")}>
        <FormSelect name="policy" defaultValue={current}>
          <option value="review">{t("money.gst.review")}</option>
          <option value="recoverable">{t("money.gst.recoverable")}</option>
          <option value="non_recoverable">{t("money.gst.non_recoverable")}</option>
        </FormSelect>
      </Field>
      <FormAlert error={state.error} message={state.ok ? state.message : undefined} />
      <SubmitButton variant="outline" className="self-start">{t("money.gst.save")}</SubmitButton>
    </form>
  );
}
