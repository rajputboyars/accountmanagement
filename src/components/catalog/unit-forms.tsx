"use client";

import { useActionState } from "react";
import { useT } from "@/components/nexora/language-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createUnitAction, setUnitActiveAction, type CatalogFormState } from "@/app/(app)/inventory/actions";
import { Field, FormAlert, SubmitButton } from "./form-bits";

export function AddUnitForm() {
  const t = useT();
  const [state, action] = useActionState<CatalogFormState, FormData>(createUnitAction, {});
  const values = state.values ?? {};
  return (
    <form key={state.nonce ?? "add-unit"} action={action} className="flex flex-col gap-3">
      <div className="grid gap-3">
        <Field label={t("units.name")} error={state.fieldErrors?.name}>
          <Input name="name" defaultValue={values.name} maxLength={40} placeholder={t("units.namePlaceholder")} className="h-11" />
        </Field>
        <Field label={t("units.short")} hint={t("units.shortHint")} error={state.fieldErrors?.code}>
          <Input name="code" defaultValue={values.code} maxLength={16} placeholder={t("units.shortPlaceholder")} className="h-11 lowercase" autoCapitalize="none" />
        </Field>
        <label className="flex min-h-11 items-center gap-2 text-sm text-foreground">
          <input type="checkbox" name="allowDecimal" defaultChecked={values.allowDecimal === "on"} className="size-5 accent-[var(--teal-strong)]" />
          {t("units.split")}
        </label>
      </div>
      <FormAlert error={state.fieldErrors ? undefined : state.error} message={state.message} />
      <div>
        <SubmitButton variant="outline">{t("units.add")}</SubmitButton>
      </div>
    </form>
  );
}

export function UnitActiveToggle({ code, active, name }: { code: string; active: boolean; name: string }) {
  const t = useT();
  const [state, action] = useActionState<CatalogFormState, FormData>(setUnitActiveAction, {});
  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="code" value={code} />
      <input type="hidden" name="active" value={active ? "false" : "true"} />
      <Button type="submit" size="sm" variant="outline">
        {active ? t("common.switchOff") : t("common.switchOn")}
        <span className="sr-only"> {name}</span>
      </Button>
      {state.error ? (
        <span role="alert" className="text-xs text-danger">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}
