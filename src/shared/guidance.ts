import type { MessageKey } from "./i18n/messages/en";
import type { HelpTopic } from "./i18n/help";
import type { Permission } from "./permissions";

/**
 * First-time tips and guided tasks. Pure definitions: the words live in the dictionaries, progress in user_guidance.
 * A task only points at the real screens; it never fills or submits anything.
 */

export const GUIDED_TASK_KEYS = ["addCustomer", "createSale", "recordPurchase", "receivePayment", "updateStock"] as const;
export type GuidedTaskKey = (typeof GUIDED_TASK_KEYS)[number];

export const GUIDE_MODULES = {
  dashboard: { topic: "moduleDashboard", permission: "reports.view", task: null },
  customers: { topic: "moduleCustomers", permission: "customers.view", task: "addCustomer" },
  billing: { topic: "moduleBilling", permission: "billing.view", task: "createSale" },
  purchases: { topic: "modulePurchases", permission: "purchases.view", task: "recordPurchase" },
  suppliers: { topic: "moduleSuppliers", permission: "purchases.view", task: null },
  inventory: { topic: "moduleInventory", permission: "inventory.view", task: "updateStock" },
  pricing: { topic: "modulePricing", permission: "pricing.edit", task: null },
  payments: { topic: "modulePayments", permission: "payments.record", task: "receivePayment" },
  cashbook: { topic: "moduleCashbook", permission: "cash.record", task: null },
  reports: { topic: "moduleReports", permission: "reports.view", task: null },
  approvals: { topic: "moduleApprovals", permission: "approvals.view", task: null },
  notifications: { topic: "moduleNotifications", permission: null, task: null },
  settings: { topic: "moduleSettings", permission: null, task: null },
} as const satisfies Record<string, { topic: HelpTopic; permission: Permission | null; task: GuidedTaskKey | null }>;

export type GuideModule = keyof typeof GUIDE_MODULES;
export const GUIDE_MODULE_KEYS = Object.keys(GUIDE_MODULES) as GuideModule[];

export function isGuideModule(value: string): value is GuideModule {
  return Object.hasOwn(GUIDE_MODULES, value);
}

/** The rule for a field, by name: the schemas themselves live in the modules and are looked up in the browser. */
export const GUIDE_FIELD_RULES = ["customerName", "customerPhone", "customerType", "customerArea", "customerCreditLimit", "customerGstin", "customerOpeningOwed", "customerOpeningAdvance", "customerOldestBill", "paymentAmount", "paymentMethod", "paymentReference", "billCash", "billUpi", "billCard", "billBank", "billCashReceived", "stockKind", "stockDirection", "stockQuantity", "stockReason"] as const;
export type GuideFieldRule = (typeof GUIDE_FIELD_RULES)[number];
/** An optional field may stay empty; once filled, it must still be valid. */
export type GuideField = { selector: string; rule: GuideFieldRule; required?: boolean };

/** The parts of the goods-receipt form a step looks at. Every line and the supplier are read together and checked by the receipt's own schema. */
export type ReceiptScope = "supplier" | "products" | "quantity" | "all";

/** What lets a step move on. Each is read from the real page; `saved` is confirmed by the server from the audit log. */
export type StepDone =
  | { kind: "view" } // the screen is open: reading is enough
  | { kind: "fields"; fields: GuideField[]; needs?: string; invalid?: string } // these inputs pass the rules their form saves by; `needs` must be on the page and `invalid` must not
  | { kind: "receipt"; scope: ReceiptScope } // every line of the goods receipt passes the rules the receipt saves by
  | { kind: "present"; selector: string; invalid?: string; needs?: string } // this has appeared, such as a line on the bill, the screen marks nothing wrong, and `needs` is on the page
  | { kind: "saved" } // the existing workflow has saved it
  | { kind: "result" }; // the confirmation after saving

export type GuidedStep = {
  id: string;
  /** The screen this step lives on, as a pattern for the pathname. */
  path: string;
  /** Where the "Open this screen" link goes when the person is elsewhere. */
  href: string;
  /** The one thing to highlight. */
  target?: string;
  done: StepDone;
  /** Extra wording when the target can't be found, and a screen that helps. */
  missing?: { message: "guide.recordPurchase.noSupplier"; href: string };
};

export type GuidedTask = {
  /** Every permission the real workflow needs: the task is offered only when all are granted. */
  permissions: readonly Permission[];
  /** The audit action the existing workflow writes in the same transaction as its save. */
  auditAction: string;
  steps: readonly GuidedStep[];
};

const UUID = "[0-9a-f-]{36}";
const VIEW = { kind: "view" } as const;
const SAVED = { kind: "saved" } as const;
const RESULT = { kind: "result" } as const;

const addForm = '[aria-labelledby="section-add-a-customer"]';
const payForm = '[aria-labelledby="section-record-a-payment"]';
const adjust = '[aria-labelledby="adjust"]';
/** The bill's totals have caught up with what is typed, and the bill's own save button says it can be saved. */
const BILL_SYNCED = '[data-guide="bill-totals"][data-guide-synced]';
const BILL_CAN_SAVE = '[data-guide="bill-save"]:not(:disabled)';
const BILL_MESSAGE = '[data-guide="bill-payment"] .text-danger, [data-guide="bill-line"] [aria-invalid="true"], main [role="alert"]';
const billAmounts: GuideField[] = [
  { selector: '[data-guide="bill-pay-cash"]', rule: "billCash" },
  { selector: '[data-guide="bill-pay-upi"]', rule: "billUpi" },
  { selector: '[data-guide="bill-pay-card"]', rule: "billCard" },
  { selector: '[data-guide="bill-pay-bank"]', rule: "billBank" },
];
const customerAll: GuideField[] = [
  { selector: `${addForm} input[name="name"]`, rule: "customerName", required: true },
  { selector: `${addForm} input[name="phone"]`, rule: "customerPhone" },
  { selector: `${addForm} select[name="type"]`, rule: "customerType", required: true },
  { selector: `${addForm} input[name="area"]`, rule: "customerArea" },
  { selector: `${addForm} input[name="creditLimit"]`, rule: "customerCreditLimit" },
  { selector: `${addForm} input[name="gstin"]`, rule: "customerGstin" },
  { selector: `${addForm} input[name="openingOwed"]`, rule: "customerOpeningOwed" },
  { selector: `${addForm} input[name="openingAdvance"]`, rule: "customerOpeningAdvance" },
  { selector: `${addForm} input[name="oldestBillDate"]`, rule: "customerOldestBill" },
];
const CUSTOMERS = "^/customers$";
const BILLING = "^/billing$";
const RECEIVE = "^/purchases/receive$";
const CUSTOMER = `^/customers/${UUID}$`;
const STOCK_LIST = "^/inventory/stock$";
const STOCK_ITEM = `^/inventory/stock/${UUID}$`;

export const GUIDED_TASKS: Record<GuidedTaskKey, GuidedTask> = {
  addCustomer: {
    permissions: ["customers.view", "customers.edit"],
    auditAction: "parties.customer_added",
    steps: [
      {
        id: "details",
        path: CUSTOMERS,
        href: "/customers",
        target: `${addForm} input[name="name"]`,
        done: {
          kind: "fields",
          fields: [
            { selector: `${addForm} input[name="name"]`, rule: "customerName", required: true },
            { selector: `${addForm} input[name="phone"]`, rule: "customerPhone" },
            { selector: `${addForm} select[name="type"]`, rule: "customerType", required: true },
          ],
        },
      },
      {
        id: "optional",
        path: CUSTOMERS,
        href: "/customers",
        target: `${addForm} input[name="area"]`,
        done: {
          kind: "fields",
          fields: [
            { selector: `${addForm} input[name="area"]`, rule: "customerArea" },
            { selector: `${addForm} input[name="creditLimit"]`, rule: "customerCreditLimit" },
            { selector: `${addForm} input[name="gstin"]`, rule: "customerGstin" },
          ],
        },
      },
      { id: "review", path: CUSTOMERS, href: "/customers", target: `${addForm} form`, done: { kind: "fields", fields: customerAll } },
      { id: "save", path: CUSTOMERS, href: "/customers", target: `${addForm} button[type="submit"]`, done: SAVED },
      { id: "done", path: ".*", href: "/customers", done: RESULT },
    ],
  },
  createSale: {
    permissions: ["billing.view", "billing.create"],
    auditAction: "sales.invoice_issued",
    steps: [
      { id: "open", path: BILLING, href: "/billing", done: VIEW },
      { id: "customer", path: BILLING, href: "/billing", target: '[data-guide="bill-customer"]', done: VIEW },
      { id: "products", path: BILLING, href: "/billing", target: '[data-guide="bill-search"]', done: { kind: "present", selector: '[data-guide="bill-line"]' } },
      { id: "quantity", path: BILLING, href: "/billing", target: '[data-guide="bill-line"]', done: { kind: "present", selector: '[data-guide="bill-line"]', invalid: '[data-guide="bill-line"] [aria-invalid="true"]', needs: BILL_SYNCED } },
      { id: "prices", path: BILLING, href: "/billing", target: '[data-guide="bill-totals"]', done: VIEW },
      { id: "payment", path: BILLING, href: "/billing", target: '[data-guide="bill-payment"]', done: { kind: "fields", fields: [...billAmounts, { selector: '[data-guide="bill-cash-received"]', rule: "billCashReceived" }], needs: BILL_CAN_SAVE, invalid: BILL_MESSAGE } },
      { id: "review", path: BILLING, href: "/billing", target: '[data-guide="bill-totals"]', done: { kind: "fields", fields: [...billAmounts, { selector: '[data-guide="bill-cash-received"]', rule: "billCashReceived" }], needs: BILL_CAN_SAVE, invalid: BILL_MESSAGE } },
      { id: "save", path: BILLING, href: "/billing", target: '[data-guide="bill-save"]', done: SAVED },
      { id: "done", path: ".*", href: "/billing/invoices", done: RESULT },
    ],
  },
  recordPurchase: {
    permissions: ["purchases.view", "stock.receive"],
    auditAction: "purchasing.goods_received",
    steps: [
      { id: "open", path: RECEIVE, href: "/purchases/receive", done: VIEW },
      {
        id: "supplier",
        path: RECEIVE,
        href: "/purchases/receive",
        target: '[data-guide="purchase-supplier"]:has(option:not([value=""]))',
        done: { kind: "receipt", scope: "supplier" },
        missing: { message: "guide.recordPurchase.noSupplier", href: "/suppliers" },
      },
      { id: "products", path: RECEIVE, href: "/purchases/receive", target: '[data-guide="purchase-product"]', done: { kind: "receipt", scope: "products" } },
      { id: "quantity", path: RECEIVE, href: "/purchases/receive", target: '[data-guide="purchase-qty"]', done: { kind: "receipt", scope: "quantity" } },
      { id: "gst", path: RECEIVE, href: "/purchases/receive", target: '[data-guide="purchase-gst"]', done: VIEW },
      { id: "review", path: RECEIVE, href: "/purchases/receive", target: '[data-guide="purchase-total"]', done: { kind: "receipt", scope: "all" } },
      { id: "save", path: RECEIVE, href: "/purchases/receive", target: '[data-guide="purchase-save"]', done: SAVED },
      { id: "done", path: ".*", href: "/purchases", done: RESULT },
    ],
  },
  receivePayment: {
    permissions: ["customers.view", "payments.record"],
    auditAction: "payments.receipt_recorded",
    steps: [
      { id: "open", path: CUSTOMER, href: "/customers", done: VIEW },
      { id: "balance", path: CUSTOMER, href: "/customers", target: '[data-guide="customer-balance"]', done: VIEW },
      { id: "form", path: CUSTOMER, href: "/customers", target: payForm, done: VIEW },
      { id: "amount", path: CUSTOMER, href: "/customers", target: `${payForm} input[name="amount"]`, done: { kind: "fields", fields: [{ selector: `${payForm} input[name="amount"]`, rule: "paymentAmount", required: true }] } },
      { id: "method", path: CUSTOMER, href: "/customers", target: `${payForm} select[name="method"]`, done: VIEW },
      { id: "reference", path: CUSTOMER, href: "/customers", target: `${payForm} input[name="reference"]`, done: { kind: "fields", fields: [{ selector: `${payForm} input[name="reference"]`, rule: "paymentReference" }] } },
      { id: "review", path: CUSTOMER, href: "/customers", target: `${payForm} form`, done: { kind: "fields", fields: [{ selector: `${payForm} input[name="amount"]`, rule: "paymentAmount", required: true }, { selector: `${payForm} select[name="method"]`, rule: "paymentMethod", required: true }, { selector: `${payForm} input[name="reference"]`, rule: "paymentReference" }] } },
      { id: "save", path: CUSTOMER, href: "/customers", target: `${payForm} button[type="submit"]`, done: SAVED },
      { id: "done", path: ".*", href: "/customers", target: '[data-guide="customer-balance"]', done: RESULT },
    ],
  },
  updateStock: {
    permissions: ["inventory.view", "stock.adjust"],
    auditAction: "inventory.adjustment_recorded",
    steps: [
      { id: "open", path: STOCK_LIST, href: "/inventory/stock", done: VIEW },
      { id: "product", path: STOCK_ITEM, href: "/inventory/stock", done: VIEW },
      { id: "available", path: STOCK_ITEM, href: "/inventory/stock", target: '[data-guide="stock-available"]', done: VIEW },
      { id: "form", path: STOCK_ITEM, href: "/inventory/stock", target: adjust, done: VIEW },
      { id: "quantity", path: STOCK_ITEM, href: "/inventory/stock", target: `${adjust} input[name="quantity"]`, done: { kind: "fields", fields: [{ selector: `${adjust} select[name="direction"]`, rule: "stockDirection", required: true }, { selector: `${adjust} input[name="quantity"]`, rule: "stockQuantity", required: true }] } },
      { id: "reason", path: STOCK_ITEM, href: "/inventory/stock", target: `${adjust} input[name="reason"]`, done: { kind: "fields", fields: [{ selector: `${adjust} input[name="reason"]`, rule: "stockReason", required: true }] } },
      { id: "review", path: STOCK_ITEM, href: "/inventory/stock", target: `${adjust} form`, done: { kind: "fields", fields: [{ selector: `${adjust} input[name="kind"]`, rule: "stockKind", required: true }, { selector: `${adjust} select[name="direction"]`, rule: "stockDirection", required: true }, { selector: `${adjust} input[name="quantity"]`, rule: "stockQuantity", required: true }, { selector: `${adjust} input[name="reason"]`, rule: "stockReason", required: true }] } },
      { id: "save", path: STOCK_ITEM, href: "/inventory/stock", target: `${adjust} button[type="submit"]`, done: SAVED },
      { id: "done", path: ".*", href: "/inventory/stock", target: '[data-guide="stock-available"]', done: RESULT },
    ],
  },
};

export function isGuidedTaskKey(value: string): value is GuidedTaskKey {
  return (GUIDED_TASK_KEYS as readonly string[]).includes(value);
}

/** The tasks this person may do; nothing else is offered or can be started. */
export function tasksFor(granted: ReadonlySet<string>): GuidedTaskKey[] {
  return GUIDED_TASK_KEYS.filter((key) => GUIDED_TASKS[key].permissions.every((permission) => granted.has(permission)));
}

export function saveStepIndex(key: GuidedTaskKey): number {
  return GUIDED_TASKS[key].steps.findIndex((step) => step.done.kind === "saved");
}

export const taskTitleKey = (key: GuidedTaskKey) => `guide.${key}.title` as MessageKey;
export const stepTitleKey = (key: GuidedTaskKey, stepId: string) => `guide.${key}.${stepId}.title` as MessageKey;
export const stepBodyKey = (key: GuidedTaskKey, stepId: string) => `guide.${key}.${stepId}.body` as MessageKey;
