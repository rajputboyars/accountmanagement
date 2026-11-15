"use client";

import { useActionState } from "react";
import { addBankAccountAction, type BankResult } from "@/app/(app)/reports/money/bank/actions";
import { Field, FormAlert, SubmitButton } from "@/components/catalog/form-bits";
import { useT } from "@/components/nexora/language-provider";
import { Input } from "@/components/ui/input";

/** Adds a bank account. The first one keeps your earlier bank payments; nothing already recorded is changed. */
export function BankAccountForm({ today, first }: { today: string; first: boolean }) {
  const t = useT();
  const [state, action] = useActionState<BankResult, FormData>(addBankAccountAction, {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{first ? t("bank.add.firstHelp") : t("bank.add.nextHelp")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("bank.add.name")} error={state.fieldErrors?.name}>
          <Input name="name" required maxLength={60} placeholder={t("bank.add.namePlaceholder")} className="h-11" />
        </Field>
        <Field label={t("bank.add.last4")} hint={t("bank.add.last4Hint")} error={state.fieldErrors?.last4}>
          <Input name="last4" inputMode="numeric" maxLength={4} pattern="\d{4}" className="h-11 tabular-nums sm:max-w-32" />
        </Field>
        <Field label={t("bank.add.balance")} hint={t("bank.add.balanceHint")} error={state.fieldErrors?.statementBalance}>
          <Input name="statementBalance" required inputMode="decimal" placeholder="0" className="h-11 tabular-nums" />
        </Field>
        <Field label={t("bank.add.asOf")} error={state.fieldErrors?.asOf}>
          <Input type="date" name="asOf" required max={today} defaultValue={today} className="h-11 sm:max-w-56" />
        </Field>
      </div>
      <label className="flex items-start gap-2 text-sm text-foreground">
        <input type="checkbox" name="addDifferenceToBooks" className="mt-1 size-4 accent-primary" />
        <span>
          {t("bank.add.addDifference")}
          <span className="block text-xs text-muted-foreground">{t("bank.add.addDifferenceHint")}</span>
        </span>
      </label>
      <FormAlert error={state.error} message={state.ok ? state.message : undefined} />
      <SubmitButton className="self-start">{t("bank.add.submit")}</SubmitButton>
    </form>
  );
}
