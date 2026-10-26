"use client";

import { useActionState } from "react";
import { Upload } from "lucide-react";
import { Field, FormAlert, FormSelect, SubmitButton } from "@/components/catalog/form-bits";
import { commitImportAction, remapImportAction, uploadImportAction, type ImportFormState } from "./actions";

const selectClass = "h-11 rounded-lg border border-input bg-background px-3 text-sm text-foreground";

export function UploadForm({ types, defaultType }: { types: { value: string; label: string }[]; defaultType?: string }) {
  const [state, action] = useActionState<ImportFormState, FormData>(uploadImportAction, {});
  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-end">
        <Field label="What to import">
          <FormSelect name="type" defaultValue={defaultType ?? types[0]?.value} className={selectClass}>
            {types.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
          </FormSelect>
        </Field>
        <Field label="CSV file" hint="Up to 900 KB and 2,000 rows. Nothing is saved until you review and confirm.">
          <input type="file" name="file" accept=".csv,text/csv" required className="h-11 rounded-lg border border-input bg-background px-2 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1 file:text-sm" />
        </Field>
        <SubmitButton>
          <Upload aria-hidden="true" />
          Check file
        </SubmitButton>
      </div>
      <FormAlert error={state.error} />
    </form>
  );
}

export function MappingForm({ jobId, headers, fields, mapping }: { jobId: string; headers: string[]; fields: { key: string; label: string; required: boolean }[]; mapping: Record<string, number | null> }) {
  const [state, action] = useActionState<ImportFormState, FormData>(remapImportAction, {});
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="jobId" value={jobId} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map((field) => (
          <Field key={field.key} label={`${field.label}${field.required ? " *" : ""}`}>
            <FormSelect name={`map:${field.key}`} defaultValue={mapping[field.key] === null || mapping[field.key] === undefined ? "" : String(mapping[field.key])} className={selectClass}>
              <option value="">— Not in file —</option>
              {headers.map((header, index) => (
                <option key={index} value={String(index)}>
                  {header || `Column ${index + 1}`}
                </option>
              ))}
            </FormSelect>
          </Field>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton variant="outline">Check again</SubmitButton>
        <FormAlert error={state.error} message={state.message} />
      </div>
    </form>
  );
}

export function CommitForm({ jobId, ready }: { jobId: string; ready: number }) {
  const [state, action] = useActionState<ImportFormState, FormData>(commitImportAction, {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="jobId" value={jobId} />
      <SubmitButton>{ready === 1 ? "Import 1 row" : `Import ${ready} rows`}</SubmitButton>
      <FormAlert error={state.error} message={state.message} />
    </form>
  );
}
