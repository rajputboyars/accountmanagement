"use server";

import { localizeServerMessage } from "@/server/i18n";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";
import {
  cancelGoodsReceipt,
  cancelPurchaseOrder,
  closePurchaseOrder,
  createPurchaseOrder,
  createPurchaseReturn,
  createProductForSupplier,
  createSupplier,
  linkSupplierProducts,
  paySupplier,
  receiveGoods,
  reverseSupplierPayment,
  setSupplierActive,
  updateSupplier,
} from "@/modules/purchasing";
import { toActionError } from "@/server/action-result";
import { getT } from "@/server/i18n";
import { requireSession } from "@/server/auth";

/**
 * Supplier and purchase actions. The session decides shop and user; the purchasing service checks
 * permissions, locks rows and writes stock, cost, ledger and payments in one transaction.
 */

export type FormResult = { ok?: boolean; id?: string; number?: string; message?: string; error?: string; code?: string; fieldErrors?: Record<string, string>; values?: Record<string, string> };

async function failure(error: unknown, values?: Record<string, string>): Promise<FormResult> {
  if (error instanceof ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of error.issues) {
      const key = issue.path.join(".");
      if (key && !fieldErrors[key]) fieldErrors[key] = await localizeServerMessage(issue.message);
    }
    return { error: await localizeServerMessage(error.issues[0]?.message ?? "Please check the form."), code: "VALIDATION", fieldErrors, values };
  }
  const result = await toActionError(error);
  return { error: result.error, code: result.code, fieldErrors: result.details?.fieldErrors as Record<string, string> | undefined, values };
}

const text = (formData: FormData, name: string) => String(formData.get(name) ?? "");

function refresh(...paths: string[]) {
  for (const path of ["/suppliers", "/purchases", "/inventory/stock", ...paths]) revalidatePath(path);
}

export async function saveSupplierAction(_previous: FormResult, formData: FormData): Promise<FormResult> {
  const supplierId = text(formData, "supplierId");
  const values = { name: text(formData, "name"), phone: text(formData, "phone"), gstin: text(formData, "gstin"), paymentTermsDays: text(formData, "paymentTermsDays") || "30" };
  let createdId: string | undefined;
  try {
    const session = await requireSession();
    if (supplierId) await updateSupplier(session, supplierId, values);
    else createdId = (await createSupplier(session, values)).id;
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, values);
  }
  refresh(supplierId ? `/suppliers/${supplierId}` : "/suppliers");
  const t = await getT();
  return { ok: true, id: createdId, message: supplierId ? t("suppliers.saved") : t("customers.added", { name: values.name }) };
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
  const values = { amount: text(formData, "amount"), method: text(formData, "method"), reference: text(formData, "reference"), bankAccountId: text(formData, "bankAccountId") };
  try {
    await paySupplier(await requireSession(), { ...values, supplierId, idempotencyKey: text(formData, "idempotencyKey") });
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, values);
  }
  refresh(`/suppliers/${supplierId}`);
  return { ok: true, message: (await getT())("suppliers.paymentRecorded") };
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
    else return { error: (await getT())("server.unknownAction") };
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
  refresh(`/purchases/receipts/${targetId}`, `/purchases/orders/${targetId}`, text(formData, "refreshPath"));
  return { ok: true, message: (await getT())("suppliers.done") };
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

const PRODUCT_FIELD_ALIASES: Record<string, string> = { retailPaise: "retailPrice", wholesalePaise: "wholesalePrice", costPaise: "costPrice" };

export type QuickProductResult = FormResult & { product?: { id: string; name: string; sku: string; baseUnit: string; gstRateBp: number } };

/** Quick-add a product from a purchase screen: the catalog's own rules, then linked to the supplier. */
export async function quickCreateProductAction(supplierId: string, values: Record<string, string>): Promise<QuickProductResult> {
  const field = (name: string) => String(values[name] ?? "");
  try {
    const session = await requireSession();
    const input = { name: field("name"), sku: field("sku"), barcode: "", categoryName: "", description: "", baseUnit: field("baseUnit"), hsn: field("hsn"), gstRateBp: field("gstRateBp"), retailPaise: field("retailPrice"), wholesalePaise: field("wholesalePrice"), costPaise: field("costPrice"), reorderLevel: "" };
    const { id } = await createProductForSupplier(session, supplierId, input);
    refresh("/inventory");
    return { ok: true, id, product: { id, name: input.name.trim(), sku: input.sku.trim().toUpperCase(), baseUnit: input.baseUnit, gstRateBp: Number(input.gstRateBp) } };
  } catch (error) {
    unstable_rethrow(error);
    const result = await failure(error, values);
    const fieldErrors = result.fieldErrors ? Object.fromEntries(Object.entries(result.fieldErrors).map(([key, message]) => [PRODUCT_FIELD_ALIASES[key] ?? key, message])) : result.code === "SKU_IN_USE" ? { sku: result.error ?? "" } : undefined;
    return { ...result, fieldErrors };
  }
}

/** Links products the shop already has to a supplier. Products already linked are left alone. */
export async function linkSupplierProductsAction(supplierId: string, productIds: string[]): Promise<FormResult & { linked?: number }> {
  try {
    const { linked } = await linkSupplierProducts(await requireSession(), supplierId, productIds);
    refresh();
    return { ok: true, linked };
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
}

/** Returns goods from a receipt and makes the supplier's debit note. The purchasing service checks quantities, stock, permissions and posts everything together. */
export async function createPurchaseReturnAction(input: unknown): Promise<FormResult> {
  try {
    const result = await createPurchaseReturn(await requireSession(), input);
    refresh("/purchases/returns");
    return { ok: true, id: result.id, number: result.number };
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
}
