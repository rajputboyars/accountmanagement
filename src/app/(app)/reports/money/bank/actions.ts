"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { createBankAccount } from "@/modules/accounting";
import { confirmMatch, finalizeReconciliation, ignoreLine, importStatement, postLine, previewStatement, restoreLine, undoMatch, type StatementPreview } from "@/modules/banking";
import { toActionError } from "@/server/action-result";
import { requireSession } from "@/server/auth";
import { getT } from "@/server/i18n";

/**
 * Bank screens' actions. The session decides the shop and user; the services check the owner's permission, recompute every figure
 * and refuse anything that does not add up. Nothing here trusts amounts from the browser.
 */
export type BankResult = { ok?: boolean; message?: string; error?: string; code?: string; fieldErrors?: Record<string, string>; preview?: StatementPreview; replayed?: boolean };

async function failure(error: unknown): Promise<BankResult> {
  const result = await toActionError(error);
  return { error: result.error, code: result.code, fieldErrors: result.details?.fieldErrors as Record<string, string> | undefined };
}

const refresh = (bankAccountId?: string) => {
  for (const path of ["/reports/money", "/reports/money/bank", ...(bankAccountId ? [`/reports/money/bank/${bankAccountId}`, `/reports/money/bank/${bankAccountId}/reconcile`] : [])]) revalidatePath(path);
};

export async function addBankAccountAction(_previous: BankResult, formData: FormData): Promise<BankResult> {
  try {
    const created = await createBankAccount(await requireSession(), {
      name: String(formData.get("name") ?? ""),
      last4: String(formData.get("last4") ?? ""),
      statementBalance: String(formData.get("statementBalance") ?? ""),
      asOf: String(formData.get("asOf") ?? ""),
      addDifferenceToBooks: formData.get("addDifferenceToBooks") === "on",
    });
    refresh(created.id);
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
  return { ok: true, message: (await getT())("bank.added") };
}

export type ImportPayload = { bankAccountId: string; fileName: string; text: string; mapping: Record<string, unknown> };

export async function previewImportAction(payload: ImportPayload): Promise<BankResult> {
  try {
    return { ok: true, preview: await previewStatement(await requireSession(), payload) };
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
}

export async function importAction(payload: ImportPayload): Promise<BankResult> {
  try {
    const result = await importStatement(await requireSession(), payload);
    refresh(payload.bankAccountId);
    return { ok: true, message: (await getT())("bank.import.done", { imported: result.imported, duplicates: result.duplicates }) };
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
}

export type MatchPayload = { idempotencyKey: string; bankAccountId: string; lineIds: string[]; itemIds: number[]; confirmLargeFee?: boolean };

export async function matchAction(payload: MatchPayload): Promise<BankResult> {
  try {
    const result = await confirmMatch(await requireSession(), payload);
    refresh(payload.bankAccountId);
    return { ok: true, replayed: result.replayed, message: (await getT())(result.kind === "settlement" ? "bank.settled" : "bank.matched") };
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
}

export type PostPayload = { idempotencyKey: string; bankAccountId: string; lineId: string; kind: string; partyId?: string; confirm: boolean };

export async function postLineAction(payload: PostPayload): Promise<BankResult> {
  try {
    const { bankAccountId, ...rest } = payload;
    await postLine(await requireSession(), rest);
    refresh(bankAccountId);
    return { ok: true, message: (await getT())("bank.posted") };
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
}

export async function ignoreLineAction(bankAccountId: string, lineId: string, reason: string): Promise<BankResult> {
  try {
    await ignoreLine(await requireSession(), { lineId, reason });
    refresh(bankAccountId);
    return { ok: true, message: (await getT())("bank.ignored") };
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
}

export async function restoreLineAction(bankAccountId: string, lineId: string): Promise<BankResult> {
  try {
    await restoreLine(await requireSession(), lineId);
    refresh(bankAccountId);
    return { ok: true, message: (await getT())("bank.restored") };
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
}

export async function undoAction(bankAccountId: string, groupId: string, reason: string, idempotencyKey: string): Promise<BankResult> {
  try {
    await undoMatch(await requireSession(), { idempotencyKey, groupId, reason });
    refresh(bankAccountId);
    return { ok: true, message: (await getT())("bank.undone") };
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
}

export async function finalizeAction(payload: { idempotencyKey: string; bankAccountId: string; statementDate: string; statementBalance: string; note: string }): Promise<BankResult> {
  try {
    await finalizeReconciliation(await requireSession(), payload);
    refresh(payload.bankAccountId);
    return { ok: true, message: (await getT())("bank.reconciled") };
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
}
