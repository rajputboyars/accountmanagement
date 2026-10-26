"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";
import { closeDay, recordCashMovement, recordExpense, reopenDay, voidExpense } from "@/modules/cashbook";
import { toActionError } from "@/server/action-result";
import { requireSession } from "@/server/auth";

/** Cashbook actions. The session decides shop and user; the cashbook service locks the day and audits. */

export type CashFormState = { ok?: boolean; message?: string; error?: string; code?: string; fieldErrors?: Record<string, string>; values?: Record<string, string> };

const text = (formData: FormData, name: string) => String(formData.get(name) ?? "");

function failure(error: unknown, values?: Record<string, string>): CashFormState {
  if (error instanceof ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of error.issues) {
      const key = String(issue.path[0] ?? "");
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { error: error.issues[0]?.message ?? "Please check the form.", fieldErrors, values };
  }
  const result = toActionError(error);
  return { error: result.error, code: result.code, fieldErrors: result.details?.fieldErrors as Record<string, string> | undefined, values };
}

export async function recordExpenseAction(_previous: CashFormState, formData: FormData): Promise<CashFormState> {
  const values = { idempotencyKey: text(formData, "idempotencyKey"), businessDate: text(formData, "businessDate"), category: text(formData, "category"), amount: text(formData, "amount"), method: text(formData, "method"), note: text(formData, "note"), reference: text(formData, "reference") };
  try {
    await recordExpense(await requireSession(), values);
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, values);
  }
  revalidatePath("/cashbook");
  return { ok: true, message: "Expense recorded." };
}

export async function recordCashMovementAction(_previous: CashFormState, formData: FormData): Promise<CashFormState> {
  const values = { idempotencyKey: text(formData, "idempotencyKey"), businessDate: text(formData, "businessDate"), kind: text(formData, "kind"), amount: text(formData, "amount"), note: text(formData, "note") };
  try {
    await recordCashMovement(await requireSession(), values);
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, values);
  }
  revalidatePath("/cashbook");
  return { ok: true, message: "Recorded." };
}

export async function voidExpenseAction(_previous: CashFormState, formData: FormData): Promise<CashFormState> {
  try {
    await voidExpense(await requireSession(), text(formData, "expenseId"), { reason: text(formData, "reason") });
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
  revalidatePath("/cashbook");
  return { ok: true };
}

export async function closeDayAction(_previous: CashFormState, formData: FormData): Promise<CashFormState> {
  const values = { businessDate: text(formData, "businessDate"), counted: text(formData, "counted"), reasonKey: text(formData, "reasonKey"), reasonNote: text(formData, "reasonNote") };
  try {
    await closeDay(await requireSession(), values);
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, values);
  }
  revalidatePath("/cashbook");
  return { ok: true, message: "Day closed." };
}

export async function reopenDayAction(_previous: CashFormState, formData: FormData): Promise<CashFormState> {
  try {
    await reopenDay(await requireSession(), text(formData, "businessDate"), { reason: text(formData, "reason") });
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
  revalidatePath("/cashbook");
  return { ok: true, message: "Day reopened." };
}
