"use client";

import { useActionState } from "react";
import { addGodownAction, renameGodownAction, toggleGodownAction, type GodownFormResult } from "@/app/(app)/settings/godown-actions";
import { Field, FormAlert, SubmitButton } from "@/components/catalog/form-bits";
import { useT } from "@/components/nexora/language-provider";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

type Row = { id: string; name: string; isDefault: boolean; isActive: boolean };

function GodownRow({ godown }: { godown: Row }) {
  const t = useT();
  const [renamed, rename] = useActionState<GodownFormResult, FormData>(renameGodownAction, {});
  const [toggled, toggle] = useActionState<GodownFormResult, FormData>(toggleGodownAction, {});
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <form action={rename} className="flex min-w-0 flex-1 flex-wrap items-end gap-2">
          <input type="hidden" name="godownId" value={godown.id} />
          <Field label={t("godown.label")} error={renamed.fieldErrors?.name} className="min-w-40 flex-1">
            <Input name="name" defaultValue={godown.isDefault && godown.name === "Main Store" ? t("godown.mainStore") : godown.name} maxLength={60} className="h-11" />
          </Field>
          <SubmitButton variant="outline">{t("godown.settings.save")}</SubmitButton>
        </form>
        {godown.isActive ? null : <Badge variant="warning">{t("godown.off")}</Badge>}
        {godown.isDefault ? null : (
          <form action={toggle}>
            <input type="hidden" name="godownId" value={godown.id} />
            <input type="hidden" name="active" value={godown.isActive ? "false" : "true"} />
            <SubmitButton variant="outline">{godown.isActive ? t("godown.settings.turnOff") : t("godown.settings.turnOn")}</SubmitButton>
          </form>
        )}
      </div>
      <FormAlert error={renamed.error ?? toggled.error} message={renamed.ok ? renamed.message : undefined} />
    </li>
  );
}

/** The owner's godown list. Shown in Settings; nothing about godowns appears elsewhere until a second one exists. */
export function GodownSettings({ godowns }: { godowns: Row[] }) {
  const t = useT();
  const [added, add] = useActionState<GodownFormResult, FormData>(addGodownAction, {});
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{t("godown.settings.hint")}</p>
      {/* With only the Main Store there is nothing to manage yet: just the way to add a second one. */}
      {godowns.length > 1 ? (
        <>
          <ul className="flex flex-col gap-3">
            {godowns.map((godown) => (
              <GodownRow key={`${godown.id}-${godown.name}-${godown.isActive}`} godown={godown} />
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{t("godown.settings.emptyFirst")}</p>
        </>
      ) : null}
      <form action={add} className="flex flex-wrap items-end gap-2">
        <Field label={t("godown.settings.name")} error={added.fieldErrors?.name} className="min-w-48 flex-1">
          <Input name="name" maxLength={60} className="h-11" />
        </Field>
        <SubmitButton>{t("godown.settings.add")}</SubmitButton>
      </form>
      <FormAlert error={added.error} message={added.ok ? added.message : undefined} />
    </div>
  );
}
