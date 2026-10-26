"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";
import {
  cancelGoodsReceipt,
  cancelPurchaseOrder,
  closePurchaseOrder,
  createPurchaseOrder,
  createSupplier,
  paySupplier,
  receiveGoods,
  reverseSupplierPayment,
  setSupplierActive,
  updateSupplier,
} from "@/modules/purchasing";
import { toActionError } from "@/server/action-result";
import { requireSession } from "@/server/auth";

/**
 * Supplier and purchase actions. The session decides shop and user; the purchasing service checks
 * permissions, locks rows and writes stock, cost, ledger and payments in one transaction.
 */

export type FormResult = { ok?: boolean; id?: string; number?: string; message?: string; error?: string; code?: string; fieldErrors?: Record<string, string>; values?: Record<string, string> };

function failure(error: unknown, values?: Record<string, string>): FormResult {
  if (error instanceof ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of error.issues) {
      const key = issue.path.join(".");
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { error: error.issues[0]?.message ?? "Please check the form.", code: "VALIDATION", fieldErrors, values };
  }
  const result = toActionError(error);
  return { error: result.error, code: result.code, fieldErrors: result.details?.fieldErrors as Record<string, string> | undefined, values };
}

const text = (formData: FormData, name: string) => String(formData.get(name) ?? "");

function refresh(...paths: string[]) {
  for (const path of ["/suppliers", "/purchases", "/inventory/stock", ...paths]) revalidatePath(path);
}

export async function saveSupplierAction(_previous: FormResult, formData: FormData): Promise<FormResult> {
  const supplierId = text(formData, "supplierId");
  const values = { name: text(formData, "name"), phone: text(formData, "phone"), gstin: text(formData, "gstin"), paymentTermsDays: text(formData, "paymentTermsDays") || "30" };
  try {
    const session = await requireSession();
    if (supplierId) await updateSupplier(session, supplierId, values);
    else await createSupplier(session, values);
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, values);
  }
  refresh(supplierId ? `/suppliers/${supplierId}` : "/suppliers");
  return { ok: true, message: supplierId ? "Supplier saved." : `${values.name} added.` };
}

export async function setSupplierActiveAction(_previous: FormResult, formData: FormData): Promise<FormResult> {
  const supplierId = text(formData, "supplierId");
  try {
    await setSupplierActive(await requireSession(), supplierId, text(formData, "active") === "true");
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
  refresh(`/suppliers/${supplierId}`);
  return { ok: true };
}

export async function paySupplierAction(_previous: FormResult, formData: FormData): Promise<FormResult> {
  const supplierId = text(formData, "supplierId");
  const values = { amount: text(formData, "amount"), method: text(formData, "method"), reference: text(formData, "reference") };
  try {
    await paySupplier(await requireSession(), { ...values, supplierId, idempotencyKey: text(formData, "idempotencyKey") });
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, values);
  }
  refresh(`/suppliers/${supplierId}`);
  return { ok: true, message: "Payment recorded." };
}

/** One action for every "are you sure? give a reason" reversal on these screens. */
export async function reversalAction(_previous: FormResult, formData: FormData): Promise<FormResult> {
  const kind = text(formData, "kind");
  const targetId = text(formData, "targetId");
  const input = { reason: text(formData, "reason") };
  try {
    const session = await requireSession();
    if (kind === "receipt") await cancelGoodsReceipt(session, targetId, input);
    else if (kind === "order-cancel") await cancelPurchaseOrder(session, targetId, input);
    else if (kind === "order-close") await closePurchaseOrder(session, targetId, input);
    else if (kind === "payment") await reverseSupplierPayment(session, targetId, input);
    else return { error: "Unknown action." };
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
  refresh(`/purchases/receipts/${targetId}`, `/purchases/orders/${targetId}`, text(formData, "refreshPath"));
  return { ok: true, message: "Done." };
}

export async function createOrderAction(input: unknown): Promise<FormResult> {
  try {
    const result = await createPurchaseOrder(await requireSession(), input);
    refresh();
    return { ok: true, id: result.id, number: result.number };
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
}

export async function receiveGoodsAction(input: unknown): Promise<FormResult> {
  try {
    const result = await receiveGoods(await requireSession(), input);
    refresh();
    return { ok: true, id: result.id, number: result.number };
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
}
