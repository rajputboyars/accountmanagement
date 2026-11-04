/**
 * Business Accounts: the chart of accounts and the rules that turn a business event into a balanced
 * journal. Pure (no database, no Node): everything here works on plain integers (paise) and strings,
 * so each rule can be tested on its own. The accounting module stores what these rules return.
 *
 * Design rules (Phase 1):
 * - Customer and supplier balances stay in ledger_entries. The Receivables and Payables accounts are
 *   controls over them; every line on those accounts names its party so the two can be tied out.
 * - Each payment method has its own account. Cash, bank, UPI, card and cheque are never merged.
 * - Money not yet verified (opening balancing figure) sits in a clearing account, never in owner's capital.
 * - Input GST goes to the account chosen by the shop's explicit policy; the default is "review".
 *   No tax rule is decided here. Which treatment is right for a shop needs its CA.
 * - Stock with no known cost is never guessed. It is recorded as a gap so reports cannot look complete.
 * - Inventory valuation is not changed: sale cost is the cost snapshot already stored on the invoice line.
 */

export const ACCOUNT_TYPES = ["asset", "liability", "equity", "income", "expense"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** How an account's money moves count in a cash-flow statement. "cash" = cash and cash-like accounts themselves. */
export const CASH_FLOW_CLASSES = ["operating", "investing", "financing", "cash", "none"] as const;
export type CashFlowClass = (typeof CASH_FLOW_CLASSES)[number];

export type AccountDef = { key: string; code: string; name: string; type: AccountType; category: string; cashFlow: CashFlowClass };

export const CHART = [
  { key: "cash", code: "1010", name: "Cash in hand", type: "asset", category: "cash_and_bank", cashFlow: "cash" },
  { key: "bank", code: "1020", name: "Bank account", type: "asset", category: "cash_and_bank", cashFlow: "cash" },
  { key: "upi", code: "1030", name: "UPI collections (not yet in bank)", type: "asset", category: "cash_and_bank", cashFlow: "cash" },
  { key: "card", code: "1040", name: "Card collections (not yet in bank)", type: "asset", category: "cash_and_bank", cashFlow: "cash" },
  { key: "cheques", code: "1050", name: "Cheques received (not yet cleared)", type: "asset", category: "cash_and_bank", cashFlow: "cash" },
  { key: "receivables", code: "1100", name: "Customers owe you", type: "asset", category: "receivables", cashFlow: "operating" },
  { key: "inventory", code: "1200", name: "Stock (valued)", type: "asset", category: "inventory", cashFlow: "operating" },
  { key: "gst_input_recoverable", code: "1310", name: "GST on purchases you can claim", type: "asset", category: "gst", cashFlow: "operating" },
  { key: "gst_input_review", code: "1320", name: "GST on purchases (to be reviewed)", type: "asset", category: "gst", cashFlow: "operating" },
  { key: "payables", code: "2100", name: "You owe suppliers", type: "liability", category: "payables", cashFlow: "operating" },
  { key: "gst_output", code: "2200", name: "GST collected on sales", type: "liability", category: "gst", cashFlow: "operating" },
  { key: "owner_capital", code: "3100", name: "Owner's capital", type: "equity", category: "owner", cashFlow: "financing" },
  { key: "owner_funds_in", code: "3110", name: "Money put in by owner", type: "equity", category: "owner", cashFlow: "financing" },
  { key: "owner_drawings", code: "3200", name: "Owner's drawings", type: "equity", category: "owner", cashFlow: "financing" },
  { key: "opening_clearing", code: "3900", name: "Opening balance clearing (unverified)", type: "equity", category: "clearing", cashFlow: "none" },
  { key: "sales", code: "4100", name: "Sales", type: "income", category: "sales", cashFlow: "operating" },
  { key: "sales_returns", code: "4110", name: "Sales returns", type: "income", category: "sales", cashFlow: "operating" },
  { key: "stock_gain", code: "4300", name: "Stock gain", type: "income", category: "stock", cashFlow: "operating" },
  { key: "round_off", code: "4900", name: "Round off", type: "income", category: "other_income", cashFlow: "operating" },
  { key: "cogs", code: "5100", name: "Cost of goods sold", type: "expense", category: "cost_of_goods", cashFlow: "operating" },
  { key: "stock_loss", code: "5200", name: "Stock loss", type: "expense", category: "stock", cashFlow: "operating" },
  { key: "gst_input_nonrecoverable", code: "5300", name: "GST on purchases you cannot claim", type: "expense", category: "gst", cashFlow: "operating" },
  { key: "expense_rent", code: "6100", name: "Rent", type: "expense", category: "expenses", cashFlow: "operating" },
  { key: "expense_salary", code: "6200", name: "Salary", type: "expense", category: "expenses", cashFlow: "operating" },
  { key: "expense_transport", code: "6300", name: "Transport", type: "expense", category: "expenses", cashFlow: "operating" },
  { key: "expense_electricity", code: "6400", name: "Electricity", type: "expense", category: "expenses", cashFlow: "operating" },
  { key: "expense_tea", code: "6500", name: "Tea and snacks", type: "expense", category: "expenses", cashFlow: "operating" },
  { key: "expense_other", code: "6900", name: "Other expenses", type: "expense", category: "expenses", cashFlow: "operating" },
] as const satisfies readonly AccountDef[];

export type AccountKey = (typeof CHART)[number]["key"];
const BY_KEY = new Map<string, AccountDef>(CHART.map((account) => [account.key, account]));
export const accountDef = (key: string): AccountDef | undefined => BY_KEY.get(key);

export const INPUT_GST_POLICIES = ["review", "recoverable", "non_recoverable"] as const;
export type InputGstPolicy = (typeof INPUT_GST_POLICIES)[number];

export const GAP_KINDS = ["cost_missing_for_sale", "cost_missing_for_return", "unvalued_stock_movement", "unvalued_opening_stock"] as const;
export type GapKind = (typeof GAP_KINDS)[number];

export type PartyRef = { type: "customer" | "supplier"; id: string };
export type LineSpec = { account: AccountKey; debitPaise: number; creditPaise: number; party?: PartyRef };
export type GapSpec = { kind: GapKind; ref: string; note: string };
/** What one business event posts. `lines` may be empty when only gaps were found (nothing to post). */
export type JournalDraft = { event: string; lines: LineSpec[]; gaps: GapSpec[] };

export const EVENTS = {
  invoice: "invoice",
  invoiceCost: "invoice_cost",
  creditNote: "credit_note",
  creditNoteRestock: "credit_note_restock",
  payment: "payment",
  goodsReceipt: "goods_receipt",
  expense: "expense",
  cashMovement: "cash_movement",
  stockAdjustment: "stock_adjustment",
  opening: "opening",
  openingReclass: "opening_reclass",
} as const;

export const reversalEvent = (event: string) => `reversal:${event}`;

export class AccountingRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountingRuleError";
  }
}

const isPaise = (value: number) => Number.isSafeInteger(value) && value >= 0;
const dr = (account: AccountKey, amount: number, party?: PartyRef): LineSpec[] => (amount > 0 ? [{ account, debitPaise: amount, creditPaise: 0, ...(party ? { party } : {}) }] : []);
const cr = (account: AccountKey, amount: number, party?: PartyRef): LineSpec[] => (amount > 0 ? [{ account, debitPaise: 0, creditPaise: amount, ...(party ? { party } : {}) }] : []);

function requirePaise(label: string, value: number) {
  if (!isPaise(value)) throw new AccountingRuleError(`${label} must be a whole number of paise, zero or more.`);
}

/** A journal must have at least two lines, whole-paise amounts on one side each, and equal debits and credits. */
export function assertBalanced(lines: readonly LineSpec[]) {
  if (lines.length < 2) throw new AccountingRuleError("A journal needs at least two lines.");
  let debit = 0;
  let credit = 0;
  for (const line of lines) {
    if (!isPaise(line.debitPaise) || !isPaise(line.creditPaise)) throw new AccountingRuleError("Journal amounts must be whole paise, zero or more.");
    if ((line.debitPaise > 0) === (line.creditPaise > 0)) throw new AccountingRuleError("Each journal line is a debit or a credit, not both and not neither.");
    if (!accountDef(line.account)) throw new AccountingRuleError(`Unknown account ${line.account}.`);
    debit += line.debitPaise;
    credit += line.creditPaise;
  }
  if (debit !== credit) throw new AccountingRuleError(`Journal does not balance: debits ${debit} and credits ${credit}.`);
}

/** The same lines with debit and credit swapped. Used for reversals, so a reversal always mirrors what was actually posted. */
export function reverseLines(lines: readonly LineSpec[]): LineSpec[] {
  return lines.map((line) => ({ ...line, debitPaise: line.creditPaise, creditPaise: line.debitPaise }));
}

/** Each payment method is its own account. Cash, bank, UPI, card and cheque are never combined. */
const PAYMENT_ACCOUNTS = { cash: "cash", bank: "bank", upi: "upi", card: "card", cheque: "cheques" } as const satisfies Record<string, AccountKey>;
export type PaymentMethod = keyof typeof PAYMENT_ACCOUNTS;
export function paymentAccount(method: string): AccountKey {
  const account = (PAYMENT_ACCOUNTS as Record<string, AccountKey>)[method];
  if (!account) throw new AccountingRuleError(`No account for payment method "${method}".`);
  return account;
}

/** Input GST lands where the shop's explicit policy says. The default, "review", decides nothing. */
export function inputGstAccount(policy: InputGstPolicy): AccountKey {
  if (policy === "recoverable") return "gst_input_recoverable";
  if (policy === "non_recoverable") return "gst_input_nonrecoverable";
  return "gst_input_review";
}

/** Whole paise of cost for a quantity (numeric(14,3) text) at a per-base-unit cost, half-up. Negative quantities keep their sign. */
export function costOf(qtyBase: string, unitCostPaise: number): number {
  if (!isPaise(unitCostPaise)) throw new AccountingRuleError("Unit cost must be whole paise.");
  const match = /^(-?)(\d+)(?:\.(\d{1,3}))?$/.exec(qtyBase.trim());
  if (!match) throw new AccountingRuleError(`"${qtyBase}" is not a quantity.`);
  const milli = BigInt(match[2]!) * BigInt(1000) + BigInt((match[3] ?? "").padEnd(3, "0") || "0");
  const paiseValue = Number((milli * BigInt(unitCostPaise) + BigInt(500)) / BigInt(1000));
  return match[1] ? -paiseValue : paiseValue;
}

export type CostedLine = { productId: string; qtyBase: string; unitCostPaise: number | null };

/** Total cost of lines that have a cost, plus a gap for each line that has none. Nothing is estimated. */
function costLines(lines: readonly CostedLine[], gapKind: GapKind) {
  let known = 0;
  const gaps: GapSpec[] = [];
  for (const line of lines) {
    if (line.unitCostPaise === null) gaps.push({ kind: gapKind, ref: line.productId, note: `No cost for ${line.qtyBase} base units` });
    else known += Math.abs(costOf(line.qtyBase, line.unitCostPaise));
  }
  return { known, gaps };
}

export function invoiceIssued(input: { customerId: string; taxablePaise: number; gstPaise: number; roundOffPaise: number; totalPaise: number }): JournalDraft {
  const { customerId, taxablePaise, gstPaise, roundOffPaise, totalPaise } = input;
  requirePaise("Taxable amount", taxablePaise);
  requirePaise("GST", gstPaise);
  requirePaise("Total", totalPaise);
  if (taxablePaise + gstPaise + roundOffPaise !== totalPaise) throw new AccountingRuleError("Invoice total must equal taxable + GST + round-off.");
  const party: PartyRef = { type: "customer", id: customerId };
  return {
    event: EVENTS.invoice,
    lines: [...dr("receivables", totalPaise, party), ...dr("round_off", roundOffPaise < 0 ? -roundOffPaise : 0), ...cr("sales", taxablePaise), ...cr("gst_output", gstPaise), ...cr("round_off", roundOffPaise > 0 ? roundOffPaise : 0)],
    gaps: [],
  };
}

/** Cost of goods sold for an invoice, from the cost saved on each line. Lines with no cost become gaps, never a guess. */
export function invoiceCost(input: { lines: readonly CostedLine[] }): JournalDraft {
  const { known, gaps } = costLines(input.lines, "cost_missing_for_sale");
  return { event: EVENTS.invoiceCost, lines: [...dr("cogs", known), ...cr("inventory", known)], gaps };
}

export function creditNoteIssued(input: { customerId: string; taxablePaise: number; gstPaise: number; roundOffPaise: number; totalPaise: number }): JournalDraft {
  const { customerId, taxablePaise, gstPaise, roundOffPaise, totalPaise } = input;
  requirePaise("Taxable amount", taxablePaise);
  requirePaise("GST", gstPaise);
  requirePaise("Total", totalPaise);
  if (taxablePaise + gstPaise + roundOffPaise !== totalPaise) throw new AccountingRuleError("Credit note total must equal taxable + GST + round-off.");
  const party: PartyRef = { type: "customer", id: customerId };
  return {
    event: EVENTS.creditNote,
    lines: [...dr("sales_returns", taxablePaise), ...dr("gst_output", gstPaise), ...dr("round_off", roundOffPaise > 0 ? roundOffPaise : 0), ...cr("receivables", totalPaise, party), ...cr("round_off", roundOffPaise < 0 ? -roundOffPaise : 0)],
    gaps: [],
  };
}

/** Goods taken back onto the shelf from a sales return, at the cost they were sold at. */
export function creditNoteRestock(input: { lines: readonly CostedLine[] }): JournalDraft {
  const { known, gaps } = costLines(input.lines, "cost_missing_for_return");
  return { event: EVENTS.creditNoteRestock, lines: [...dr("inventory", known), ...cr("cogs", known)], gaps };
}

/** Customer receipts and refunds, supplier payments and refunds. Each moves the party's control account and the exact payment account. */
export function paymentRecorded(input: { direction: "in" | "out"; partyType: "customer" | "supplier" | "none"; partyId: string | null; method: string; amountPaise: number }): JournalDraft {
  const { direction, partyType, partyId, method, amountPaise } = input;
  requirePaise("Amount", amountPaise);
  if (partyType === "none" || !partyId) throw new AccountingRuleError("A payment with no customer or supplier has no account to post to yet.");
  const money = paymentAccount(method);
  const party: PartyRef = { type: partyType, id: partyId };
  const control: AccountKey = partyType === "customer" ? "receivables" : "payables";
  const lines = direction === "in" ? [...dr(money, amountPaise), ...cr(control, amountPaise, party)] : [...dr(control, amountPaise, party), ...cr(money, amountPaise)];
  return { event: EVENTS.payment, lines, gaps: [] };
}

/** Stock received from a supplier. GST goes where the shop's policy says; the default decides nothing. */
export function goodsReceived(input: { supplierId: string; taxablePaise: number; gstPaise: number; totalPaise: number; inputGstPolicy: InputGstPolicy }): JournalDraft {
  const { supplierId, taxablePaise, gstPaise, totalPaise, inputGstPolicy } = input;
  requirePaise("Taxable amount", taxablePaise);
  requirePaise("GST", gstPaise);
  requirePaise("Total", totalPaise);
  if (taxablePaise + gstPaise !== totalPaise) throw new AccountingRuleError("Receipt total must equal taxable + GST.");
  const party: PartyRef = { type: "supplier", id: supplierId };
  return { event: EVENTS.goodsReceipt, lines: [...dr("inventory", taxablePaise), ...dr(inputGstAccount(inputGstPolicy), gstPaise), ...cr("payables", totalPaise, party)], gaps: [] };
}

const EXPENSE_ACCOUNTS: Record<string, AccountKey> = {
  rent: "expense_rent",
  salary: "expense_salary",
  transport: "expense_transport",
  electricity: "expense_electricity",
  tea: "expense_tea",
  other: "expense_other",
};

export function expenseRecorded(input: { category: string; method: string; amountPaise: number }): JournalDraft {
  requirePaise("Amount", input.amountPaise);
  const expense = EXPENSE_ACCOUNTS[input.category];
  if (!expense) throw new AccountingRuleError(`No account for expense category "${input.category}".`);
  return { event: EVENTS.expense, lines: [...dr(expense, input.amountPaise), ...cr(paymentAccount(input.method), input.amountPaise)], gaps: [] };
}

export function cashMoved(input: { kind: "withdrawal" | "bank_deposit" | "float_added"; amountPaise: number }): JournalDraft {
  requirePaise("Amount", input.amountPaise);
  const { kind, amountPaise } = input;
  const lines =
    kind === "withdrawal" ? [...dr("owner_drawings", amountPaise), ...cr("cash", amountPaise)] : kind === "bank_deposit" ? [...dr("bank", amountPaise), ...cr("cash", amountPaise)] : [...dr("cash", amountPaise), ...cr("owner_funds_in", amountPaise)];
  return { event: EVENTS.cashMovement, lines, gaps: [] };
}

/** Damaged stock and stock-count corrections. Signed quantities: negative is a loss, positive a gain. Unvalued lines become gaps. */
export function stockAdjusted(input: { lines: readonly CostedLine[] }): JournalDraft {
  let loss = 0;
  let gain = 0;
  const gaps: GapSpec[] = [];
  for (const line of input.lines) {
    if (line.unitCostPaise === null) {
      gaps.push({ kind: "unvalued_stock_movement", ref: line.productId, note: `No cost for ${line.qtyBase} base units` });
      continue;
    }
    const value = costOf(line.qtyBase, line.unitCostPaise);
    if (value < 0) loss += -value;
    else gain += value;
  }
  return { event: EVENTS.stockAdjustment, lines: [...dr("stock_loss", loss), ...cr("inventory", loss), ...dr("inventory", gain), ...cr("stock_gain", gain)], gaps };
}

export type OpeningInput = {
  /** Customer balances as at the close of the day before books start; positive = the customer owes the shop. */
  receivables: readonly { partyId: string; balancePaise: number }[];
  /** Supplier balances in the same convention as the party ledger (debit minus credit); negative = the shop owes the supplier. */
  payables: readonly { partyId: string; balancePaise: number }[];
  inventoryPaise: number;
  cashPaise: number;
  bankPaise: number;
  upiPaise: number;
  cardPaise: number;
  chequesPaise: number;
  /** Anything else the owner entered, on balance-sheet accounts only (not the clearing account). */
  other: readonly { account: AccountKey; side: "debit" | "credit"; amountPaise: number }[];
  /** Products that had stock but no cost at the cutover date. They are not valued. */
  unvaluedProductIds: readonly string[];
};

/**
 * The opening journal. Whatever does not balance goes to the clearing account, never to owner's capital:
 * capital is a decision the owner and their accountant make later (see openingReclass).
 */
export function openingJournal(input: OpeningInput): JournalDraft {
  for (const [label, value] of [["Inventory", input.inventoryPaise], ["Cash", input.cashPaise], ["Bank", input.bankPaise], ["UPI", input.upiPaise], ["Card", input.cardPaise], ["Cheques", input.chequesPaise]] as const) requirePaise(label, value);
  const lines: LineSpec[] = [...dr("inventory", input.inventoryPaise), ...dr("cash", input.cashPaise), ...dr("bank", input.bankPaise), ...dr("upi", input.upiPaise), ...dr("card", input.cardPaise), ...dr("cheques", input.chequesPaise)];
  for (const row of input.receivables) {
    const party: PartyRef = { type: "customer", id: row.partyId };
    if (!Number.isSafeInteger(row.balancePaise)) throw new AccountingRuleError("Customer balance must be whole paise.");
    lines.push(...(row.balancePaise >= 0 ? dr("receivables", row.balancePaise, party) : cr("receivables", -row.balancePaise, party)));
  }
  for (const row of input.payables) {
    const party: PartyRef = { type: "supplier", id: row.partyId };
    if (!Number.isSafeInteger(row.balancePaise)) throw new AccountingRuleError("Supplier balance must be whole paise.");
    lines.push(...(row.balancePaise <= 0 ? cr("payables", -row.balancePaise, party) : dr("payables", row.balancePaise, party)));
  }
  for (const row of input.other) {
    const def = accountDef(row.account);
    if (!def || def.category === "clearing" || (def.type !== "asset" && def.type !== "liability" && def.type !== "equity")) throw new AccountingRuleError(`"${row.account}" cannot be an opening balance.`);
    requirePaise("Opening amount", row.amountPaise);
    lines.push(...(row.side === "debit" ? dr(row.account, row.amountPaise) : cr(row.account, row.amountPaise)));
  }
  const debit = lines.reduce((sum, line) => sum + line.debitPaise, 0);
  const credit = lines.reduce((sum, line) => sum + line.creditPaise, 0);
  lines.push(...(debit > credit ? cr("opening_clearing", debit - credit) : dr("opening_clearing", credit - debit)));
  const gaps: GapSpec[] = input.unvaluedProductIds.map((productId) => ({ kind: "unvalued_opening_stock", ref: productId, note: "Opening stock has no known cost" }));
  return { event: EVENTS.opening, lines, gaps };
}

/** The owner's explicit confirmation: move the clearing balance to owner's capital. `clearingBalancePaise` is debit minus credit. */
export function openingReclass(clearingBalancePaise: number): JournalDraft {
  if (!Number.isSafeInteger(clearingBalancePaise)) throw new AccountingRuleError("Clearing balance must be whole paise.");
  const amount = Math.abs(clearingBalancePaise);
  const lines = clearingBalancePaise < 0 ? [...dr("opening_clearing", amount), ...cr("owner_capital", amount)] : [...dr("owner_capital", amount), ...cr("opening_clearing", amount)];
  return { event: EVENTS.openingReclass, lines, gaps: [] };
}

export type CashFlowLine = { cashFlow: CashFlowClass; debitPaise: number; creditPaise: number };
export type CashFlowSplit = { operating: number; investing: number; financing: number; unclassified: number; net: number };

/**
 * How one journal moves cash, by classification. Each non-cash line contributes (credit - debit) to its own
 * class, so a journal that mixes classes is split exactly with no allocation guesswork, and a move between two
 * cash accounts nets to zero. Lines on accounts with no classification (e.g. the clearing account) are reported
 * as unclassified so a statement can say so instead of hiding them.
 */
export function cashFlowOf(lines: readonly CashFlowLine[]): CashFlowSplit {
  const split: CashFlowSplit = { operating: 0, investing: 0, financing: 0, unclassified: 0, net: 0 };
  for (const line of lines) {
    if (line.cashFlow === "cash") {
      split.net += line.debitPaise - line.creditPaise;
      continue;
    }
    const amount = line.creditPaise - line.debitPaise;
    if (line.cashFlow === "none") split.unclassified += amount;
    else split[line.cashFlow] += amount;
  }
  // A journal with no cash line moves no cash, whatever its other lines say.
  if (!lines.some((line) => line.cashFlow === "cash")) return { operating: 0, investing: 0, financing: 0, unclassified: 0, net: 0 };
  return split;
}
