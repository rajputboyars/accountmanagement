"use server";

import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";
import { createReturn, findInvoiceByNumber, previewReturn, type ReturnPreview } from "@/modules/sales";
import { toActionError } from "@/server/action-result";
import { requireSession } from "@/server/auth";

/**
 * Return actions. The session decides shop and user; the sales service locks the bill, checks what
 * is left to return and works out every amount. The amount the screen showed is only compared.
 */

export type ReturnPayload = {
  invoiceId: string;
  lines: { invoiceLineId: string; baseQty: string; restock: boolean }[];
  reason: string;
  settlement: string;
};

type Failure = { error: string; code?: string; fieldErrors?: Record<string, string> };

function failure(error: unknown): Failure {
  if (error instanceof ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of error.issues) {
      const key = issue.path.join(".");
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { error: error.issues[0]?.message ?? "Please check the return.", code: "VALIDATION", fieldErrors };
  }
  const result = toActionError(error);
  return { error: result.error, code: result.code, fieldErrors: result.details?.fieldErrors as Record<string, string> | undefined };
}

export async function findInvoiceAction(_previous: { error?: string }, formData: FormData): Promise<{ error?: string }> {
  const number = String(formData.get("number") ?? "");
  let found: { id: string } | null;
  try {
    found = await findInvoiceByNumber(await requireSession(), number);
  } catch (error) {
    unstable_rethrow(error);
    return { error: toActionError(error).error };
  }
  if (!found) return { error: `No bill numbered "${number.trim()}" in this shop.` };
  redirect(`/billing/returns/new?invoice=${found.id}`);
}

export async function previewReturnAction(input: ReturnPayload): Promise<{ preview?: ReturnPreview } & Partial<Failure>> {
  try {
    return { preview: await previewReturn(await requireSession(), input) };
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
}

export async function saveReturnAction(input: ReturnPayload & { idempotencyKey: string; expectedTotalPaise: number }): Promise<{ creditNoteId?: string; preview?: ReturnPreview } & Partial<Failure>> {
  try {
    const result = await createReturn(await requireSession(), input);
    revalidatePath("/billing/returns");
    revalidatePath(`/billing/invoices/${input.invoiceId}`);
    revalidatePath("/inventory/stock");
    return { creditNoteId: result.id };
  } catch (error) {
    unstable_rethrow(error);
    const preview = toActionError(error).details?.preview as ReturnPreview | undefined;
    return { ...failure(error), preview };
  }
}
