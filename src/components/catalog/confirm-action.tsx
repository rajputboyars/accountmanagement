"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import type { CatalogFormState } from "@/app/(app)/inventory/actions";
import { FormAlert, SubmitButton } from "./form-bits";

/** A button that asks "Are you sure?" before running an important action, such as switching a product off. */
export function ConfirmAction({
  action,
  fields,
  label,
  confirmLabel,
  question,
  destructive = false,
}: {
  action: (previous: CatalogFormState, formData: FormData) => Promise<CatalogFormState>;
  fields: Record<string, string>;
  label: string;
  confirmLabel: string;
  question: string;
  destructive?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const [state, formAction] = useActionState<CatalogFormState, FormData>(async (previous, formData) => {
    const result = await action(previous, formData);
    setAsking(false);
    return result;
  }, {});

  return (
    <div className="flex flex-col gap-3">
      {asking ? (
        <form action={formAction} className="flex flex-col gap-3 rounded-xl border border-border bg-muted/50 p-4">
          {Object.entries(fields).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <p className="text-sm text-foreground">{question}</p>
          <div className="flex flex-wrap gap-2">
            <SubmitButton variant={destructive ? "destructive" : "default"}>{confirmLabel}</SubmitButton>
            <Button type="button" size="touch" variant="ghost" onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button type="button" size="touch" variant={destructive ? "outline" : "default"} onClick={() => setAsking(true)} className="self-start">
          {label}
        </Button>
      )}
      <FormAlert error={state.error} message={state.message} />
    </div>
  );
}
