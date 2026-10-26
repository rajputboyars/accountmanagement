"use client";

import { useActionState, useState } from "react";
import { Printer } from "lucide-react";
import { cancelInvoiceAction } from "@/app/(app)/billing/actions";
import { Field, FormAlert, SubmitButton } from "@/components/catalog/form-bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function PrintButton() {
  return (
    <Button type="button" variant="outline" size="touch" onClick={() => window.print()}>
      <Printer aria-hidden="true" />
      Print
    </Button>
  );
}

/** Owner only, today's bills only (checked again on the server). Asks for a reason first. */
export function CancelInvoice({ invoiceId, number }: { invoiceId: string; number: string }) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(cancelInvoiceAction, {});
  if (!open) {
    return (
      <Button type="button" variant="outline" size="touch" onClick={() => setOpen(true)}>
        Cancel bill
      </Button>
    );
  }
  return (
    <form action={action} className="flex w-full flex-col gap-3 rounded-xl border border-border bg-muted/50 p-4">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <p className="text-sm text-foreground">
        Cancel {number}? Stock comes back, payments are recorded as refunded by the same method, and the customer&apos;s dues are reversed. The bill stays on record as cancelled.
      </p>
      <Field label="Reason" error={state.error}>
        <Input name="reason" maxLength={200} placeholder="e.g. Wrong items billed" className="h-11" />
      </Field>
      <div className="flex flex-wrap gap-2">
        <SubmitButton variant="destructive">Yes, cancel bill</SubmitButton>
        <Button type="button" variant="ghost" size="touch" onClick={() => setOpen(false)}>
          Keep bill
        </Button>
      </div>
      <FormAlert message={state.ok ? "Bill cancelled." : undefined} />
    </form>
  );
}
