"use server";

import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { commitImport, IMPORT_LIMITS, previewImport, remapImport } from "@/modules/imports";
import { toActionError } from "@/server/action-result";
import { requireSession } from "@/server/auth";

/** Import actions. The session decides shop and user; the imports service checks permissions and limits. */

export type ImportFormState = { ok?: boolean; error?: string; message?: string };

export async function uploadImportAction(_previous: ImportFormState, formData: FormData): Promise<ImportFormState> {
  let jobId: string;
  try {
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV file." };
    if (file.size > IMPORT_LIMITS.maxBytes) return { error: "The file is larger than 900 KB. Split it into smaller files." };
    if (!/\.(csv|txt)$/i.test(file.name)) return { error: "Upload a .csv file (in Excel: File → Save As → CSV)." };
    const job = await previewImport(await requireSession(), { type: formData.get("type"), fileName: file.name, text: await file.text() });
    jobId = job.id;
  } catch (error) {
    unstable_rethrow(error);
    return toActionError(error);
  }
  revalidatePath("/settings/setup");
  redirect(`/settings/setup/imports/${jobId}`);
}

export async function remapImportAction(_previous: ImportFormState, formData: FormData): Promise<ImportFormState> {
  const jobId = String(formData.get("jobId") ?? "");
  try {
    const mapping = Object.fromEntries([...formData.entries()].filter(([key]) => key.startsWith("map:")).map(([key, value]) => [key.slice(4), String(value)]));
    await remapImport(await requireSession(), jobId, mapping);
  } catch (error) {
    unstable_rethrow(error);
    return toActionError(error);
  }
  revalidatePath(`/settings/setup/imports/${jobId}`);
  return { ok: true, message: "Columns updated and rows checked again." };
}

export async function commitImportAction(_previous: ImportFormState, formData: FormData): Promise<ImportFormState> {
  const jobId = String(formData.get("jobId") ?? "");
  try {
    const result = await commitImport(await requireSession(), jobId);
    revalidatePath(`/settings/setup/imports/${jobId}`);
    revalidatePath("/settings/setup");
    return { ok: true, message: `${result.summary.created} saved, ${result.summary.skipped} skipped, ${result.summary.errors} with errors.` };
  } catch (error) {
    unstable_rethrow(error);
    return toActionError(error);
  }
}
