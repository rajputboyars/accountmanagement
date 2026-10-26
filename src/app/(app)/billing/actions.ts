"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";
import { cancelInvoice, createInvoice, previewBill, searchSellableProducts, type BillView } from "@/modules/sales";
import { toActionError } from "@/server/action-result";
import { requireSession } from "@/server/auth";

/**
 * Billing server actions. The session decides shop, user and role; the sales service prices every
 * line, checks stock and dues under row locks, and saves in one transaction. Nothing the browser
 * sends about prices or totals is trusted: the expected total and rates are only compared.
 */

export type BillInputPayload = {
  customerId: string;
  priceList: string;
  discountPercent: string;
  lines: { productId: string; unit: string; quantity: string }[];
  payments: { cash: string; upi: string; card: string; bank: string };
  cashReceived: string;
};

type Failure = { error: string; code?: string; fieldErrors?: Record<string, string> };

function failure(error: unknown): Failure {
  if (error instanceof ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of error.issues) {
      const key = issue.path.join(".");
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { error: error.issues[0]?.message ?? "Please check the bill.", code: "VALIDATION", fieldErrors };
  }
  const result = toActionError(error);
  return { error: result.error, code: result.code };
}

export async function previewBillAction(input: BillInputPayload): Promise<{ bill?: BillView } & Partial<Failure>> {
  try {
    return { bill: await previewBill(await requireSession(), input) };
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
}

export async function saveBillAction(
  input: BillInputPayload & { idempotencyKey: string; expectedTotalPaise: number; expectedRates: number[] },
): Promise<{ invoiceId?: string; number?: string; replayed?: boolean; bill?: BillView } & Partial<Failure>> {
  try {
    const result = await createInvoice(await requireSession(), input);
    revalidatePath("/billing/invoices");
    revalidatePath("/inventory/stock");
    return { invoiceId: result.id, number: result.number, replayed: result.replayed };
  } catch (error) {
    unstable_rethrow(error);
    const result = toActionError(error);
    // PRICE_CHANGED and stock/credit refusals carry the freshly computed bill.
    const bill = (result.details?.bill as BillView | undefined) ?? undefined;
    return bill ? { ...failure(error), bill } : failure(error);
  }
}

export async function searchProductsAction(q: string) {
  try {
    return { products: await searchSellableProducts(await requireSession(), q.slice(0, 60)) };
  } catch (error) {
    unstable_rethrow(error);
    return { products: [], error: toActionError(error).error };
  }
}

export async function cancelInvoiceAction(_previous: { error?: string; ok?: boolean }, formData: FormData): Promise<{ error?: string; ok?: boolean }> {
  const invoiceId = String(formData.get("invoiceId") ?? "");
  try {
    await cancelInvoice(await requireSession(), invoiceId, { reason: String(formData.get("reason") ?? "") });
  } catch (error) {
    unstable_rethrow(error);
    return { error: failure(error).error };
  }
  revalidatePath(`/billing/invoices/${invoiceId}`);
  revalidatePath("/billing/invoices");
  return { ok: true };
}
