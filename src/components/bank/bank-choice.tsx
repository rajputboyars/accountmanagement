"use client";

import { Field, selectClass } from "@/components/catalog/form-bits";
import { useT } from "@/components/nexora/language-provider";

export type BankChoice = { id: string; name: string; last4: string | null; isDefault: boolean };

/** Which bank account a bank payment went through. Shown only for bank payments, and only when the shop has more than one. */
export function BankAccountSelect({ accounts, error }: { accounts: BankChoice[]; error?: string }) {
  const t = useT();
  const first = accounts.find((account) => account.isDefault) ?? accounts[0];
  return (
    <Field label={t("bank.choose.label")} hint={t("bank.choose.hint")} error={error}>
      <select name="bankAccountId" defaultValue={first?.id} className={selectClass}>
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.name}
            {account.last4 ? ` ••${account.last4}` : ""}
          </option>
        ))}
      </select>
    </Field>
  );
}
