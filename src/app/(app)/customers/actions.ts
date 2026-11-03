"use server";

import { getT, localizeServerMessage } from "@/server/i18n";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";
import { createCustomer, setCustomerCommunicationLanguage, updateCustomer } from "@/modules/parties";
import { recordCustomerReceipt, reverseCustomerReceipt } from "@/modules/payments";
import { logReminder, prepareReminder, processWhatsAppOutbox } from "@/modules/reporting";
import { toActionError } from "@/server/action-result";
import { requireSession } from "@/server/auth";
import { formatPaise } from "@/shared/money";

/** Customer actions. The session decides shop and user; services check permissions, lock and audit. */

export type FormState = { ok?: boolean; message?: string; error?: string; fieldErrors?: Record<string, string>; values?: Record<string, string> };

const text = (formData: FormData, name: string) => String(formData.get(name) ?? "");

async function failure(error: unknown, values?: Record<string, string>): Promise<FormState> {
  if (error instanceof ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of error.issues) {
      const key = String(issue.path[0] ?? "");
      if (key && !fieldErrors[key]) fieldErrors[key] = await localizeServerMessage(issue.message);
    }
    return { error: await localizeServerMessage(error.issues[0]?.message ?? "Please check the form."), fieldErrors, values };
  }
  const result = await toActionError(error);
  return { error: result.error, fieldErrors: result.details?.fieldErrors as Record<string, string> | undefined, values };
}

const FIELDS = ["name", "phone", "type", "area", "gstin", "creditLimit", "whatsappConsent", "communicationLanguage", "openingOwed", "openingAdvance", "oldestBillDate"];

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
  const t = await getT();
  return { ok: true, message: customerId ? t("customers.saved") : t("customers.added", { name: values.name! }) };
}

export async function recordReceiptAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const customerId = text(formData, "customerId");
  const values = { amount: text(formData, "amount"), method: text(formData, "method"), reference: text(formData, "reference") };
  try {
    const result = await recordCustomerReceipt(await requireSession(), { ...values, customerId, idempotencyKey: text(formData, "idempotencyKey") });
    revalidatePath(`/customers/${customerId}`);
    revalidatePath("/customers");
    revalidatePath("/cashbook");
    const t = await getT();
    return { ok: true, message: result.advancePaise > 0 ? t("customers.receiptAdvance", { number: result.receiptNumber, amount: formatPaise(result.advancePaise, { withPaise: true }) }) : t("customers.receiptSaved", { number: result.receiptNumber }) };
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

/** Saves the language this customer reads messages in. Only runs when the person asks to save it. */
export async function saveCustomerLanguageAction(customerId: string, language: string): Promise<{ ok?: true; error?: string }> {
  try {
    await setCustomerCommunicationLanguage(await requireSession(), customerId, language);
    revalidatePath(`/customers/${customerId}`);
    return { ok: true };
  } catch (error) {
    unstable_rethrow(error);
    return { error: (await toActionError(error)).error };
  }
}

export async function prepareReminderAction(customerId: string) {
  try {
    return { reminder: await prepareReminder(await requireSession(), customerId) };
  } catch (error) {
    unstable_rethrow(error);
    return { error: (await toActionError(error)).error };
  }
}

export async function logReminderAction(customerId: string, channel: "provider" | "shared") {
  try {
    const session = await requireSession();
    const result = await logReminder(session, customerId, channel);
    if (channel === "provider") {
      // Send right after the response; the outbox retries anything that fails.
      after(() => processWhatsAppOutbox({ shopId: session.shopId }).then(() => undefined));
      revalidatePath(`/customers/${customerId}`);
    }
    return result;
  } catch (error) {
    unstable_rethrow(error);
    return { error: (await toActionError(error)).error };
  }
}
