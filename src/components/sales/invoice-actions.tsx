"use client";

import { useActionState, useState } from "react";
import { Printer } from "lucide-react";
import { cancelInvoiceAction } from "@/app/(app)/billing/actions";
import { Field, FormAlert, SubmitButton } from "@/components/catalog/form-bits";
import { useT } from "@/components/nexora/language-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function PrintButton() {
  const t = useT();
  return (
    <Button type="button" variant="outline" size="touch" onClick={() => window.print()}>
      <Printer aria-hidden="true" />
      {t("common.print")}
    </Button>
  );
}

/** Owner only, today's bills only (checked again on the server). Asks for a reason first. */
export function CancelInvoice({ invoiceId, number }: { invoiceId: string; number: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(cancelInvoiceAction, {});
  if (!open) {
    return (
      <Button type="button" variant="outline" size="touch" onClick={() => setOpen(true)}>
        {t("bill.cancel")}
      </Button>
    );
  }
  return (
    <form action={action} className="flex w-full flex-col gap-3 rounded-xl border border-border bg-muted/50 p-4">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <p className="text-sm text-foreground">
        {t("bill.cancelConfirm", { number })}
      </p>
      <Field label={t("common.reason")} error={state.error}>
        <Input name="reason" maxLength={200} placeholder={t("bill.cancelReasonPlaceholder")} className="h-11" />
      </Field>
      <div className="flex flex-wrap gap-2">
        <SubmitButton variant="destructive">{t("bill.cancelYes")}</SubmitButton>
        <Button type="button" variant="ghost" size="touch" onClick={() => setOpen(false)}>
          {t("bill.keep")}
        </Button>
      </div>
      <FormAlert message={state.ok ? t("bill.cancelled") : undefined} />
    </form>
  );
}
