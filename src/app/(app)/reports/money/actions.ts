"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { activateBusinessAccounts, confirmOpeningBalances, recordDerivedOpening, setInputGstPolicy, valueOpeningStock } from "@/modules/accounting";
import { toActionError } from "@/server/action-result";
import { requireSession } from "@/server/auth";
import { getT } from "@/server/i18n";
import { parseRupeesToPaise } from "@/shared/money";

/** Business Accounts setup actions. The session decides shop and user; the accounting service checks the owner's permission. */
export type MoneyResult = { ok?: boolean; message?: string; error?: string; fieldErrors?: Record<string, string> };

async function failure(error: unknown): Promise<MoneyResult> {
  const result = await toActionError(error);
  return { error: result.error, fieldErrors: result.details?.fieldErrors as Record<string, string> | undefined };
}

const refresh = () => {
  for (const path of ["/reports", "/reports/money", "/reports/money/setup", "/reports/money/accountant"]) revalidatePath(path);
};

export async function activateAction(_previous: MoneyResult, formData: FormData): Promise<MoneyResult> {
  try {
    await activateBusinessAccounts(await requireSession(), { coverageStartDate: String(formData.get("coverageStartDate") ?? "") });
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
  refresh();
  return { ok: true, message: (await getT())("money.setup.started") };
}

/** Rupee text from the form to whole paise. Empty means nothing. */
function rupees(formData: FormData, name: string): { value: number } | { error: string } {
  const raw = String(formData.get(name) ?? "").trim();
  if (raw === "") return { value: 0 };
  const paise = parseRupeesToPaise(raw);
  if (paise === null || paise < 0) return { error: name };
  return { value: paise };
}

export async function completeOpeningAction(_previous: MoneyResult, formData: FormData): Promise<MoneyResult> {
  const names = ["cash", "bank", "upi", "card", "cheques"] as const;
  const values: Record<string, number> = {};
  const fieldErrors: Record<string, string> = {};
  for (const name of names) {
    const parsed = rupees(formData, name);
    if ("error" in parsed) fieldErrors[name] = (await getT())("money.setup.enterAmount");
    else values[name] = parsed.value;
  }
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };
  try {
    await recordDerivedOpening(await requireSession(), { cashPaise: values.cash!, bankPaise: values.bank!, upiPaise: values.upi!, cardPaise: values.card!, chequesPaise: values.cheques! });
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
  refresh();
  return { ok: true, message: (await getT())("money.setup.saved") };
}

export async function confirmOpeningAction(): Promise<MoneyResult> {
  try {
    await confirmOpeningBalances(await requireSession());
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
  refresh();
  return { ok: true, message: (await getT())("money.setup.confirmed") };
}

export async function setGstPolicyAction(_previous: MoneyResult, formData: FormData): Promise<MoneyResult> {
  try {
    await setInputGstPolicy(await requireSession(), String(formData.get("policy") ?? ""));
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
  refresh();
  return { ok: true, message: (await getT())("money.gst.saved") };
}

/** Confirms a cost for opening stock that had none. The owner gives a cost per unit or a total value and where it came from. */
export async function valueStockAction(_previous: MoneyResult, formData: FormData): Promise<MoneyResult> {
  const t = await getT();
  const mode = String(formData.get("mode") ?? "unit");
  const amount = rupees(formData, "amount");
  if ("error" in amount || amount.value <= 0) return { fieldErrors: { amount: t("money.setup.enterAmount") } };
  const quantity = String(formData.get("quantity") ?? "").trim();
  try {
    const result = await valueOpeningStock(await requireSession(), {
      gapId: String(formData.get("gapId") ?? ""),
      idempotencyKey: String(formData.get("idempotencyKey") ?? ""),
      quantity: quantity || undefined,
      ...(mode === "total" ? { totalValuePaise: amount.value } : { unitCostPaise: amount.value }),
      source: String(formData.get("source") ?? ""),
    });
    refresh();
    revalidatePath("/reports/money/fix");
    return { ok: true, message: Number(result.remainingQuantity) > 0 ? t("money.fix.saved", { remaining: result.remainingQuantity, unit: String(formData.get("unit") ?? "") }) : t("money.fix.done") };
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
}
