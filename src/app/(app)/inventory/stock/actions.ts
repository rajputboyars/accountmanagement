"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";
import { rebuildStockCache, recordAdjustment, recordOpeningStock, type AdjustmentResult, type OpeningResult } from "@/modules/inventory";
import { toActionError } from "@/server/action-result";
import { requireSession } from "@/server/auth";

/**
 * Stock server actions. The session decides the shop and user; the inventory services check
 * permissions, lock rows and write the journal. Quantities from the form are only inputs: the
 * server converts and checks them, and works out every resulting balance itself.
 */

type Failure = { ok: false; error: string; code?: string; fieldErrors?: Record<string, string> };

/** Field errors keyed by the full path ("lines.2.quantity"), so multi-line forms can place them. */
function failure(error: unknown): Failure {
  if (error instanceof ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of error.issues) {
      const key = issue.path.join(".");
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { ok: false, error: "Some entries need attention. Nothing was saved.", code: "VALIDATION", fieldErrors };
  }
  const result = toActionError(error);
  const fromDetails = result.details?.fieldErrors as Record<string, string> | undefined;
  return { ok: false, error: result.error, code: result.code, fieldErrors: fromDetails };
}

export type OpeningFormState = { result?: OpeningResult & { replayed: boolean } } & Partial<Failure>;

export async function recordOpeningAction(_previous: OpeningFormState, formData: FormData): Promise<OpeningFormState> {
  let payload: unknown;
  try {
    payload = JSON.parse(String(formData.get("payload") ?? "null"));
  } catch {
    return { ok: false, error: "The form could not be read. Reload the page and try again." };
  }
  try {
    const result = await recordOpeningStock(await requireSession(), payload);
    revalidatePath("/inventory/stock");
    return { result };
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
}

export type AdjustmentFormState = { result?: AdjustmentResult & { replayed: boolean }; values?: Record<string, string> } & Partial<Failure>;

export async function recordAdjustmentAction(_previous: AdjustmentFormState, formData: FormData): Promise<AdjustmentFormState> {
  const values = Object.fromEntries(["idempotencyKey", "productId", "kind", "direction", "unit", "quantity", "reason"].map((name) => [name, String(formData.get(name) ?? "")]));
  try {
    const result = await recordAdjustment(await requireSession(), values);
    revalidatePath("/inventory/stock");
    revalidatePath(`/inventory/stock/${values.productId}`);
    return { result };
  } catch (error) {
    unstable_rethrow(error);
    return { ...failure(error), values };
  }
}

export async function rebuildCacheAction(_previous: { ok?: boolean; error?: string }, formData: FormData): Promise<{ ok?: boolean; error?: string }> {
  const productId = String(formData.get("productId") ?? "");
  try {
    await rebuildStockCache(await requireSession(), productId);
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, error: toActionError(error).error };
  }
  revalidatePath("/inventory/stock");
  revalidatePath(`/inventory/stock/${productId}`);
  return { ok: true };
}
