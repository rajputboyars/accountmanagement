"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { loadProductNames } from "@/modules/catalog";
import { ANY_TARGET, decideApproval, requestApproval, type RequestableAction } from "@/modules/identity";
import { findCustomer } from "@/modules/parties";
import { findInvoiceByNumber } from "@/modules/sales";
import { toActionError } from "@/server/action-result";
import { requireSession } from "@/server/auth";
import { NotFoundError } from "@/server/errors";
import { getLanguage, getT, localizeServerMessage } from "@/server/i18n";
import { systemName } from "@/shared/i18n/labels";
import { parseRupeesToPaise } from "@/shared/money";
import { parsePercentToBasisPoints } from "@/shared/pricing-engine";

export type FormState = {
  ok?: boolean;
  error?: string;
  message?: string;
  nonce?: number;
  approvalId?: string;
};

/**
 * A staff member asks the owner. The record's name shown to the owner is looked up here on the server
 * (scoped to the session's shop), never taken from the form. Amounts are parsed with integer maths.
 */
export async function requestApprovalAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => String(formData.get(name) ?? "").trim();
  try {
    const session = await requireSession();
    const action = text("action") as RequestableAction;
    const targetRef = text("targetRef");
    let targetLabel = "";
    let amountPaise: number | null = null;
    let limitBp: number | null = null;
    if (action === "discount_over_limit" || action === "credit_over_limit") {
      if (targetRef === ANY_TARGET && action === "discount_over_limit") targetLabel = "Any customer";
      else if (/^[0-9a-f-]{36}$/i.test(targetRef)) targetLabel = (await findCustomer(session.shopId, targetRef)).name;
    } else if (action === "stock_adjustment" && /^[0-9a-f-]{36}$/i.test(targetRef)) {
      const product = (await loadProductNames(session.shopId, [targetRef])).get(targetRef);
      if (!product) throw new NotFoundError("Product not found.");
      targetLabel = product.name;
    } else if (action === "edit_invoice" && targetRef) {
      const invoice = await findInvoiceByNumber(session, targetRef);
      if (!invoice) throw new NotFoundError(`No bill numbered ${targetRef}.`);
      targetLabel = invoice.number;
    }
    if (action === "discount_over_limit") {
      limitBp = parsePercentToBasisPoints(text("discountPercent"));
      if (limitBp === null || limitBp <= 0 || limitBp > 10_000) return { error: await localizeServerMessage("Enter the discount % you need, for example 10.") };
    }
    if (action === "credit_over_limit" || action === "stock_adjustment") {
      const raw = text("amount");
      amountPaise = raw ? parseRupeesToPaise(raw) : null;
      if (raw && (amountPaise === null || amountPaise <= 0)) return { error: await localizeServerMessage("Enter the amount in rupees, more than 0.") };
    }
    const result = await requestApproval(session, {
      action,
      targetRef: action === "edit_invoice" ? targetLabel || targetRef : targetRef,
      targetLabel: targetLabel || targetRef || "-",
      reason: text("reason"),
      amountPaise,
      limitBp,
      quantity: text("quantity") || null,
    });
    revalidatePath("/approvals");
    const [t, language] = await Promise.all([getT(), getLanguage()]);
    const name = systemName(result.targetLabel, language);
    return {
      ok: true,
      message: result.duplicate ? t("approvals.alreadyAsked", { name }) : t("approvals.asked", { name, note: await localizeServerMessage(result.notification.note) }),
      nonce: Date.now(),
    };
  } catch (error) {
    unstable_rethrow(error);
    return await toActionError(error);
  }
}

export async function decideApprovalAction(_previous: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await requireSession();
    const approvalId = String(formData.get("approvalId") ?? "");
    const decision = String(formData.get("decision") ?? "") as "approve" | "reject";
    const reason = formData.get("reason") ? String(formData.get("reason")) : undefined;

    const result = await decideApproval(session, {
      approvalId,
      decision,
      reason,
    });

    revalidatePath("/approvals");
    const [t, language] = await Promise.all([getT(), getLanguage()]);
    const name = systemName(result.targetLabel, language);

    return {
      ok: true,
      message: t(result.status === "approved" ? "approvals.decidedApproved" : "approvals.decidedRejected", { name }),
      nonce: Date.now(),
    };
  } catch (error) {
    unstable_rethrow(error);
    return await toActionError(error);
  }
}
