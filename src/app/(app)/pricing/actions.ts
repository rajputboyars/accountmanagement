"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import {
  addCustomerRule,
  addSlab,
  quoteForSession,
  setCustomerRuleActive,
  setSlabActive,
  updateCustomerRule,
  updateSlabPrice,
  type QuoteResult,
} from "@/modules/pricing";
import { toActionError } from "@/server/action-result";
import { requireSession } from "@/server/auth";
import { getLanguage, getT } from "@/server/i18n";
import { translateServerMessage } from "@/shared/i18n";
import { rateReasonLabel } from "@/shared/i18n/labels";

/**
 * Pricing server actions. Each one re-reads the session; the pricing services check permissions
 * and scope every query to the session's shop. Prices typed here are only inputs to the server's
 * own checks; nothing from the form decides identity, shop or a final price.
 */

export type PricingFormState = {
  ok?: boolean;
  error?: string;
  message?: string;
  fieldErrors?: Record<string, string>;
  values?: Record<string, string>;
  /** True when the server refused a below-cost price that the owner may confirm. */
  needsCostConfirm?: boolean;
  nonce?: number;
};

const text = (formData: FormData, name: string) => String(formData.get(name) ?? "");

/** Conflicts that belong to one form field, so the message shows next to that input. */
const CONFLICT_FIELDS: Record<string, string> = { SLAB_EXISTS: "minQty", RULE_EXISTS: "customerId", BELOW_COST: "price", CUSTOMER_INACTIVE: "customerId", PRODUCT_INACTIVE: "productId" };

async function failure(error: unknown, values?: Record<string, string>): Promise<PricingFormState> {
  const result = await toActionError(error);
  const conflictField = result.code ? CONFLICT_FIELDS[result.code] : undefined;
  const fieldErrors = result.fieldErrors ?? (conflictField && values && conflictField in values ? { [conflictField]: result.error } : undefined);
  return { ok: false, error: result.error, fieldErrors, values, needsCostConfirm: result.code === "BELOW_COST" };
}

function refresh(productId?: string) {
  revalidatePath("/pricing");
  if (productId) revalidatePath(`/pricing/${productId}`);
}

export async function addSlabAction(_previous: PricingFormState, formData: FormData): Promise<PricingFormState> {
  const productId = text(formData, "productId");
  const values = { minQty: text(formData, "minQty"), price: text(formData, "price"), confirmBelowCost: text(formData, "confirmBelowCost") };
  try {
    await addSlab(await requireSession(), productId, values);
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, values);
  }
  refresh(productId);
  return { ok: true, message: (await getT())("pricing.slabAdded"), nonce: Date.now() };
}

export async function updateSlabAction(_previous: PricingFormState, formData: FormData): Promise<PricingFormState> {
  const productId = text(formData, "productId");
  const values = { price: text(formData, "price"), confirmBelowCost: text(formData, "confirmBelowCost") };
  try {
    await updateSlabPrice(await requireSession(), productId, text(formData, "slabId"), values);
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, values);
  }
  refresh(productId);
  return { ok: true, message: (await getT())("pricing.slabSaved"), nonce: Date.now() };
}

export async function setSlabActiveAction(_previous: PricingFormState, formData: FormData): Promise<PricingFormState> {
  const productId = text(formData, "productId");
  const active = text(formData, "active") === "true";
  try {
    await setSlabActive(await requireSession(), productId, text(formData, "slabId"), active);
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
  refresh(productId);
  return { ok: true, message: (await getT())(active ? "pricing.slabActive" : "pricing.slabRetired"), nonce: Date.now() };
}

export async function addRuleAction(_previous: PricingFormState, formData: FormData): Promise<PricingFormState> {
  const values = {
    kind: text(formData, "kind"),
    customerId: text(formData, "customerId"),
    productId: text(formData, "productId"),
    price: text(formData, "price"),
    percent: text(formData, "percent"),
    minQty: text(formData, "minQty"),
    confirmBelowCost: text(formData, "confirmBelowCost"),
  };
  try {
    await addCustomerRule(await requireSession(), values);
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, values);
  }
  refresh(values.productId || undefined);
  return { ok: true, message: (await getT())("pricing.ruleAdded"), nonce: Date.now() };
}

export async function updateRuleAction(_previous: PricingFormState, formData: FormData): Promise<PricingFormState> {
  const productId = text(formData, "productId");
  const values = { price: text(formData, "price"), percent: text(formData, "percent"), minQty: text(formData, "minQty"), confirmBelowCost: text(formData, "confirmBelowCost") };
  try {
    await updateCustomerRule(await requireSession(), text(formData, "ruleId"), values);
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, values);
  }
  refresh(productId || undefined);
  return { ok: true, message: (await getT())("pricing.ruleSaved"), nonce: Date.now() };
}

export async function setRuleActiveAction(_previous: PricingFormState, formData: FormData): Promise<PricingFormState> {
  const productId = text(formData, "productId");
  const active = text(formData, "active") === "true";
  try {
    await setCustomerRuleActive(await requireSession(), text(formData, "ruleId"), active);
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
  refresh(productId || undefined);
  return { ok: true, message: (await getT())(active ? "pricing.ruleActive" : "pricing.ruleRetired"), nonce: Date.now() };
}

export type QuoteFormState = { quote?: QuoteResult; error?: string; fieldErrors?: Record<string, string>; values?: Record<string, string> };

/** Price check: read-only. Creates no bill, payment, stock movement or ledger entry. */
export async function quoteAction(_previous: QuoteFormState, formData: FormData): Promise<QuoteFormState> {
  const values = {
    productId: text(formData, "productId"),
    unit: text(formData, "unit"),
    quantity: text(formData, "quantity"),
    customerId: text(formData, "customerId"),
    priceList: text(formData, "priceList"),
  };
  try {
    const quote = await quoteForSession(await requireSession(), values);
    const language = await getLanguage();
    const say = (line: string) => translateServerMessage(line, language);
    return { quote: { ...quote, badge: rateReasonLabel(quote.badge, language), priceListReason: say(quote.priceListReason), explanation: quote.explanation.map(say) }, values };
  } catch (error) {
    unstable_rethrow(error);
    const result = await toActionError(error);
    return { error: result.error, fieldErrors: result.fieldErrors, values };
  }
}
