"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";
import { cancelDeliveryChallan, cancelSalesOrder, closeSalesOrder, confirmSalesOrder, createDeliveryChallan, createSalesOrder, reserveOrderStock } from "@/modules/sales";
import { toActionError } from "@/server/action-result";
import { requireSession } from "@/server/auth";
import { getT, localizeServerMessage } from "@/server/i18n";

/**
 * Order, delivery and challan actions. The session decides shop and user; the sales service checks permissions, locks the stock and
 * order rows, and writes the order, reservation, stock, books and audit together or not at all.
 */
export type OrderResult = { ok?: boolean; id?: string; number?: string; message?: string; error?: string; fieldErrors?: Record<string, string> };

async function failure(error: unknown): Promise<OrderResult> {
  if (error instanceof ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of error.issues) {
      const key = issue.path.join(".");
      if (key && !fieldErrors[key]) fieldErrors[key] = await localizeServerMessage(issue.message);
    }
    return { error: await localizeServerMessage(error.issues[0]?.message ?? "Please check the form."), fieldErrors };
  }
  const result = await toActionError(error);
  return { error: result.error, fieldErrors: result.details?.fieldErrors as Record<string, string> | undefined };
}

const refresh = (orderId?: string) => {
  for (const path of ["/billing/orders", "/billing", "/inventory/stock", ...(orderId ? [`/billing/orders/${orderId}`, `/billing/orders/${orderId}/bill`] : [])]) revalidatePath(path);
};

export async function createOrderAction(input: unknown): Promise<OrderResult> {
  try {
    const result = await createSalesOrder(await requireSession(), input);
    refresh();
    return { ok: true, id: result.id, number: result.number, message: (await getT())("orders.created", { number: result.number }) };
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
}

export async function confirmOrderAction(orderId: string, godownId?: string): Promise<OrderResult> {
  try {
    await confirmSalesOrder(await requireSession(), orderId, { godownId });
    refresh(orderId);
    return { ok: true };
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
}

export async function reserveOrderAction(orderId: string): Promise<OrderResult> {
  try {
    await reserveOrderStock(await requireSession(), orderId);
    refresh(orderId);
    return { ok: true };
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
}

export async function cancelOrderAction(orderId: string, reason: string): Promise<OrderResult> {
  try {
    await cancelSalesOrder(await requireSession(), orderId, { reason });
    refresh(orderId);
    return { ok: true };
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
}

export async function closeOrderAction(orderId: string, reason: string): Promise<OrderResult> {
  try {
    await closeSalesOrder(await requireSession(), orderId, { reason });
    refresh(orderId);
    return { ok: true };
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
}

export async function deliverAction(input: unknown): Promise<OrderResult> {
  try {
    const result = await createDeliveryChallan(await requireSession(), input);
    refresh((input as { orderId?: string }).orderId);
    return { ok: true, id: result.id, number: result.number, message: (await getT())("orders.deliver.done", { number: result.number }) };
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
}

export async function cancelChallanAction(challanId: string, orderId: string, reason: string): Promise<OrderResult> {
  try {
    await cancelDeliveryChallan(await requireSession(), challanId, { reason });
    refresh(orderId);
    return { ok: true };
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
}
