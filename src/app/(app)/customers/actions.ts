"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";
import { createCustomer, updateCustomer } from "@/modules/parties";
import { recordCustomerReceipt, reverseCustomerReceipt } from "@/modules/payments";
import { logReminder, prepareReminder } from "@/modules/reporting";
import { toActionError } from "@/server/action-result";
import { requireSession } from "@/server/auth";
import { formatPaise } from "@/shared/money";

/** Customer actions. The session decides shop and user; services check permissions, lock and audit. */

export type FormState = { ok?: boolean; message?: string; error?: string; fieldErrors?: Record<string, string>; values?: Record<string, string> };

const text = (formData: FormData, name: string) => String(formData.get(name) ?? "");

function failure(error: unknown, values?: Record<string, string>): FormState {
  if (error instanceof ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of error.issues) {
      const key = String(issue.path[0] ?? "");
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { error: error.issues[0]?.message ?? "Please check the form.", fieldErrors, values };
  }
  const result = toActionError(error);
  return { error: result.error, fieldErrors: result.details?.fieldErrors as Record<string, string> | undefined, values };
}

const FIELDS = ["name", "phone", "type", "area", "gstin", "creditLimit", "whatsappConsent", "openingOwed", "openingAdvance", "oldestBillDate"];

export async function saveCustomerAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const customerId = text(formData, "customerId");
  const values = Object.fromEntries(FIELDS.map((field) => [field, text(formData, field)]));
  try {
    const session = await requireSession();
    if (customerId) await updateCustomer(session, customerId, values);
    else await createCustomer(session, values);
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, values);
  }
  revalidatePath("/customers");
  if (customerId) revalidatePath(`/customers/${customerId}`);
  return { ok: true, message: customerId ? "Details saved." : `${values.name} added.` };
}

export async function recordReceiptAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const customerId = text(formData, "customerId");
  const values = { amount: text(formData, "amount"), method: text(formData, "method"), reference: text(formData, "reference") };
  try {
    const result = await recordCustomerReceipt(await requireSession(), { ...values, customerId, idempotencyKey: text(formData, "idempotencyKey") });
    revalidatePath(`/customers/${customerId}`);
    revalidatePath("/customers");
    revalidatePath("/cashbook");
    return { ok: true, message: result.advancePaise > 0 ? `${result.receiptNumber} saved. ${formatPaise(result.advancePaise, { withPaise: true })} is kept as an advance.` : `${result.receiptNumber} saved.` };
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, values);
  }
}

export async function reverseReceiptAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const customerId = text(formData, "customerId");
  try {
    await reverseCustomerReceipt(await requireSession(), text(formData, "paymentId"), { reason: text(formData, "reason") });
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
  revalidatePath(`/customers/${customerId}`);
  revalidatePath("/cashbook");
  return { ok: true };
}

export async function prepareReminderAction(customerId: string) {
  try {
    return { reminder: await prepareReminder(await requireSession(), customerId) };
  } catch (error) {
    unstable_rethrow(error);
    return { error: toActionError(error).error };
  }
}

export async function logReminderAction(customerId: string, channel: "provider" | "shared") {
  try {
    return await logReminder(await requireSession(), customerId, channel);
  } catch (error) {
    unstable_rethrow(error);
    return { error: toActionError(error).error };
  }
}
