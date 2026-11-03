import type { z } from "zod";
import { adjustmentInputSchema } from "@/modules/inventory/validation";
import { customerCreateSchema } from "@/modules/parties/validation";
import { receiptInputSchema } from "@/modules/payments/validation";
import { receiptInputSchema as goodsReceiptSchema } from "@/modules/purchasing/validation";
import { billInputSchema } from "@/modules/sales/validation";
import type { GuidedStep, GuideFieldRule, ReceiptScope } from "@/shared/guidance";
import { en, type MessageKey } from "@/shared/i18n/messages/en";
import type { Translate } from "@/shared/i18n/translate";
import { lightCheck, SCREEN_MESSAGE, type StepCheck } from "./guide-page";

/**
 * Loaded on demand (see the runner), because it carries the validation library and the English wording used to find a
 * message's translation. The forms' own schemas are used as they are: nothing is restated here.
 */

export type { StepCheck };

const customer = customerCreateSchema.shape;
const billPayments = billInputSchema.shape.payments.unwrap().shape;

const RULES: Record<GuideFieldRule, z.ZodType> = {
  customerName: customer.name,
  customerPhone: customer.phone,
  customerType: customer.type,
  customerArea: customer.area,
  customerCreditLimit: customer.creditLimit,
  customerGstin: customer.gstin,
  customerOpeningOwed: customer.openingOwed,
  customerOpeningAdvance: customer.openingAdvance,
  customerOldestBill: customer.oldestBillDate,
  paymentAmount: receiptInputSchema.shape.amount,
  paymentMethod: receiptInputSchema.shape.method,
  paymentReference: receiptInputSchema.shape.reference,
  billCash: billPayments.cash,
  billUpi: billPayments.upi,
  billCard: billPayments.card,
  billBank: billPayments.bank,
  billCashReceived: billInputSchema.shape.cashReceived,
  stockKind: adjustmentInputSchema.shape.kind,
  stockDirection: adjustmentInputSchema.shape.direction,
  stockQuantity: adjustmentInputSchema.shape.quantity,
  stockReason: adjustmentInputSchema.shape.reason,
};

/** Why a value fails its rule, as the form's English message; null when it passes. */
export function fieldProblem(rule: GuideFieldRule, value: string): string | null {
  const result = RULES[rule].safeParse(value);
  return result.success ? null : (result.error.issues[0]?.message ?? "");
}

let keyByMessage: Map<string, MessageKey> | undefined;

/** The translation key of a form's message; a message with no translation gets a plain one, never stray English. */
export function messageKey(message: string): MessageKey {
  if (!keyByMessage) {
    keyByMessage = new Map();
    for (const key of Object.keys(en) as MessageKey[]) if (key.startsWith("server.") && !keyByMessage.has(en[key])) keyByMessage.set(en[key], key);
  }
  return keyByMessage.get(message) ?? "guide.ui.invalidField";
}

export function problemText(problem: string, t: Translate): string {
  return t(messageKey(problem));
}

/** Reads the live page. A problem in the field being typed in waits until the person leaves it. */
export function checkStep(step: GuidedStep): StepCheck {
  const light = lightCheck(step);
  if (light) return light;
  const { done } = step;
  if (done.kind === "receipt") return checkReceipt(done.scope);
  if (done.kind !== "fields") return { ready: false, problem: null };
  let ready = false;
  let problem: MessageKey | null = null;
  let blocked = false;
  for (const field of done.fields) {
    const element = document.querySelector<HTMLInputElement | HTMLSelectElement>(field.selector);
    // A field the current choice doesn't show isn't needed, such as "more or less" on a damage entry.
    if (!element) continue;
    ready = true;
    const value = element.value.trim();
    if (value === "") {
      if (field.required) blocked = true;
      continue;
    }
    const found = fieldProblem(field.rule, value);
    if (found === null) continue;
    blocked = true;
    if (problem === null && element !== document.activeElement) problem = messageKey(found);
  }
  // The screen's own checks, such as a bill the server has worked out and found wrong, decide the rest.
  if (done.needs && !document.querySelector(done.needs)) blocked = true;
  if (done.invalid && document.querySelector(done.invalid)) {
    blocked = true;
    problem ??= SCREEN_MESSAGE;
  }
  return { ready: ready && !blocked, problem };
}

/** Only the quantity-and-price checks of a line are about "quantity"; the rest of a line is about its product. */
const LINE_FIELDS: Record<string, string> = {
  productId: "purchase-product",
  unit: "purchase-unit",
  quantity: "purchase-qty",
  cost: "purchase-cost",
  gstRateBp: "purchase-gst",
};
const QUANTITY_FIELDS = new Set(["unit", "quantity", "cost", "gstRateBp"]);
// The receipt's key rule wants one; this copy of the receipt is only checked, never sent.
const CHECK_ONLY_KEY = "guide-check-only";
// The schema's cross-field rules (a supplier is needed, no product twice) are skipped while any other field is wrong. So a step checks
// its own part of the receipt, with a valid stand-in for the parts it isn't about.
const STAND_IN_PRODUCT = "00000000-0000-4000-8000-000000000000";

const valueOf = (root: ParentNode, name: string) => root.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-guide="${name}"]`)?.value ?? "";

function inScope(path: PropertyKey[], scope: ReceiptScope): boolean {
  const [head, , field] = path;
  if (head === "idempotencyKey" || head === "purchaseOrderId") return false;
  if (scope === "all") return true;
  if (scope === "supplier") return head === "supplierId";
  if (head !== "lines") return false;
  if (path.length === 1) return true;
  return scope === "products" ? field === "productId" : QUANTITY_FIELDS.has(String(field));
}

/**
 * Every line of the goods receipt, judged by the receipt's own schema. Rows are the ones the form would save: those with a
 * quantity, plus any with a product chosen, so a half-filled row is pointed out rather than silently left off.
 */
function checkReceipt(scope: ReceiptScope): StepCheck {
  const supplier = document.querySelector<HTMLSelectElement>('[data-guide="purchase-supplier"]');
  const rowElements = [...document.querySelectorAll('[data-guide="purchase-line"]')];
  if (!supplier || rowElements.length === 0) return { ready: false, problem: null };
  const rows = rowElements
    .map((element) => ({
      element,
      productId: valueOf(element, "purchase-product"),
      unit: valueOf(element, "purchase-unit"),
      quantity: valueOf(element, "purchase-qty").trim(),
      cost: valueOf(element, "purchase-cost"),
      gstRateBp: valueOf(element, "purchase-gst"),
    }))
    .filter((row) => row.productId !== "" || (row.quantity !== "" && row.quantity !== "0"));
  const priced = scope === "products" || scope === "supplier";
  const result = goodsReceiptSchema.safeParse({
    idempotencyKey: CHECK_ONLY_KEY,
    purchaseOrderId: "",
    supplierId: supplier.value,
    supplierBillNo: scope === "all" ? valueOf(document, "purchase-bill-no") : "",
    supplierBillDate: scope === "all" ? valueOf(document, "purchase-bill-date") : "",
    lines:
      scope === "supplier"
        ? [{ purchaseOrderLineId: "", productId: STAND_IN_PRODUCT, unit: "", quantity: "1", cost: "1", gstRateBp: "0" }]
        : rows.map(({ productId, unit, quantity, cost, gstRateBp }) => ({
            purchaseOrderLineId: "",
            productId,
            unit,
            quantity: priced ? "1" : quantity,
            cost: priced ? "1" : cost,
            gstRateBp: priced ? "0" : gstRateBp,
          })),
  });
  const issues = result.success ? [] : result.error.issues.filter((issue) => inScope(issue.path, scope));
  let problem: MessageKey | null = null;
  for (const issue of issues) {
    const [head, index, field] = issue.path;
    const element =
      head === "supplierId"
        ? supplier
        : head === "supplierBillNo"
          ? document.querySelector('[data-guide="purchase-bill-no"]')
          : head === "supplierBillDate"
            ? document.querySelector('[data-guide="purchase-bill-date"]')
            : typeof index === "number"
              ? rows[index]?.element.querySelector(`[data-guide="${LINE_FIELDS[String(field)] ?? ""}"]`)
              : null;
    // Nothing entered yet is not an error to point at; a wrong value is, once the person has left it. A line is only here because
    // something was entered on it, so a line with a quantity and no product is pointed at.
    const blank = !(element instanceof HTMLInputElement || element instanceof HTMLSelectElement) || (element.value.trim() === "" && field !== "productId");
    if (problem === null && !blank && element !== document.activeElement) problem = messageKey(issue.message);
  }
  return { ready: issues.length === 0, problem };
}
