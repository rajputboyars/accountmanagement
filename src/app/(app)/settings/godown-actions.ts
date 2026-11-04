"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { createGodown, renameGodown, setGodownActive } from "@/modules/inventory";
import { toActionError } from "@/server/action-result";
import { requireSession } from "@/server/auth";
import { getT } from "@/server/i18n";

/** Godown management (owner). The inventory service checks the permission and keeps the history of every godown. */
export type GodownFormResult = { ok?: boolean; message?: string; error?: string; fieldErrors?: Record<string, string> };

async function failure(error: unknown): Promise<GodownFormResult> {
  const result = await toActionError(error);
  return { error: result.error, fieldErrors: result.details?.fieldErrors as Record<string, string> | undefined };
}

const refresh = () => {
  for (const path of ["/settings", "/inventory/stock", "/inventory/stock/transfer", "/billing", "/purchases/receive"]) revalidatePath(path);
};

export async function addGodownAction(_previous: GodownFormResult, formData: FormData): Promise<GodownFormResult> {
  try {
    await createGodown(await requireSession(), { name: String(formData.get("name") ?? "") });
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
  refresh();
  return { ok: true, message: (await getT())("godown.settings.added") };
}

export async function renameGodownAction(_previous: GodownFormResult, formData: FormData): Promise<GodownFormResult> {
  try {
    await renameGodown(await requireSession(), String(formData.get("godownId") ?? ""), { name: String(formData.get("name") ?? "") });
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
  refresh();
  return { ok: true, message: (await getT())("godown.settings.saved") };
}

export async function toggleGodownAction(_previous: GodownFormResult, formData: FormData): Promise<GodownFormResult> {
  try {
    await setGodownActive(await requireSession(), String(formData.get("godownId") ?? ""), String(formData.get("active") ?? "") === "true");
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
  refresh();
  return { ok: true };
}
