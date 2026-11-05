import { and, eq, like } from "drizzle-orm";
import type { Transaction } from "@/server/db";
import { accounts, journalLines, journals } from "./schema";
import {
  cashMoved,
  creditNoteIssued,
  creditNoteRestock,
  deliveredGoodsBilled,
  EVENTS,
  goodsDelivered,
  purchaseReturned,
  inputGstAccount,
  expenseRecorded,
  goodsReceived,
  invoiceCost,
  invoiceIssued,
  partyOpeningAdded,
  paymentRecorded,
  stockAdjusted,
  stockOpeningAdded,
  type CostedLine,
} from "@/shared/accounting";
import { indiaDate } from "@/shared/financial-year";
import { loadAccountingSettings, openingRecorded, postJournal, resolveGapsFor, reverseBySource, type PostingContext } from "./service";

/**
 * What the existing workflows call to keep the books in step. Each function is one business event, runs inside the
 * caller's transaction and does nothing when Business Accounts are off or the event pre-dates the books, so shops that
 * have not turned them on see no change. The amounts come from the document the caller has just saved, never from the browser.
 */

type Money = { taxablePaise: number; gstPaise: number; roundOffPaise: number; totalPaise: number };

export async function postInvoiceIssued(tx: Transaction, ctx: PostingContext, a: { invoiceId: string; date: string; customerId: string; lines: CostedLine[]; /** Goods already left on a delivery challan: their cost moves out of "delivered, not yet billed". */ fromDelivery?: boolean } & Money) {
  await postJournal(tx, ctx, { entryDate: a.date, sourceType: "invoice", sourceId: a.invoiceId, draft: invoiceIssued({ customerId: a.customerId, taxablePaise: a.taxablePaise, gstPaise: a.gstPaise, roundOffPaise: a.roundOffPaise, totalPaise: a.totalPaise }) });
  await postJournal(tx, ctx, { entryDate: a.date, sourceType: "invoice", sourceId: a.invoiceId, draft: a.fromDelivery ? deliveredGoodsBilled({ lines: a.lines }) : invoiceCost({ lines: a.lines }) });
}

export async function postInvoiceCancelled(tx: Transaction, ctx: PostingContext, a: { invoiceId: string; date: string }) {
  await reverseBySource(tx, ctx, { sourceType: "invoice", sourceId: a.invoiceId, event: EVENTS.invoice, entryDate: a.date, memo: "Bill cancelled" });
  await reverseBySource(tx, ctx, { sourceType: "invoice", sourceId: a.invoiceId, event: EVENTS.invoiceCost, entryDate: a.date, memo: "Bill cancelled" });
  await resolveGapsFor(tx, ctx, "invoice", a.invoiceId);
}

/** A sales return. Restocked goods go back into stock at their sold cost; goods returned damaged are written off. */
export async function postCreditNote(tx: Transaction, ctx: PostingContext, a: { creditNoteId: string; date: string; customerId: string; returned: CostedLine[]; damaged: CostedLine[] } & Money) {
  await postJournal(tx, ctx, { entryDate: a.date, sourceType: "credit_note", sourceId: a.creditNoteId, draft: creditNoteIssued({ customerId: a.customerId, taxablePaise: a.taxablePaise, gstPaise: a.gstPaise, roundOffPaise: a.roundOffPaise, totalPaise: a.totalPaise }) });
  await postJournal(tx, ctx, { entryDate: a.date, sourceType: "credit_note", sourceId: a.creditNoteId, draft: creditNoteRestock({ lines: a.returned }) });
  if (a.damaged.length > 0) {
    await postJournal(tx, ctx, { entryDate: a.date, sourceType: "credit_note", sourceId: a.creditNoteId, draft: stockAdjusted({ lines: a.damaged.map((line) => ({ ...line, qtyBase: `-${line.qtyBase.replace(/^-/, "")}` })) }) });
  }
}

/** One payment row (money in or out). Counter payments with no named customer pass the bill's walk-in customer. */
export async function postPayment(tx: Transaction, ctx: PostingContext, a: { paymentId: string; date: string; direction: "in" | "out"; partyType: "customer" | "supplier"; partyId: string; method: string; amountPaise: number }) {
  await postJournal(tx, ctx, { entryDate: a.date, sourceType: "payment", sourceId: a.paymentId, draft: paymentRecorded({ direction: a.direction, partyType: a.partyType, partyId: a.partyId, method: a.method, amountPaise: a.amountPaise }) });
}

export async function postGoodsReceived(tx: Transaction, ctx: PostingContext, a: { receiptId: string; date: string; supplierId: string; taxablePaise: number; gstPaise: number; totalPaise: number }) {
  const settings = await loadAccountingSettings(tx, ctx.shopId);
  if (!settings) return;
  await postJournal(tx, ctx, { entryDate: a.date, sourceType: "goods_receipt", sourceId: a.receiptId, draft: goodsReceived({ supplierId: a.supplierId, taxablePaise: a.taxablePaise, gstPaise: a.gstPaise, totalPaise: a.totalPaise, inputGstPolicy: settings.inputGstPolicy }) });
}

export async function postGoodsReceiptCancelled(tx: Transaction, ctx: PostingContext, a: { receiptId: string; date: string }) {
  await reverseBySource(tx, ctx, { sourceType: "goods_receipt", sourceId: a.receiptId, event: EVENTS.goodsReceipt, entryDate: a.date, memo: "Receipt cancelled" });
}

export async function postExpense(tx: Transaction, ctx: PostingContext, a: { expenseId: string; date: string; category: string; method: string; amountPaise: number }) {
  await postJournal(tx, ctx, { entryDate: a.date, sourceType: "expense", sourceId: a.expenseId, draft: expenseRecorded({ category: a.category, method: a.method, amountPaise: a.amountPaise }) });
}

export async function postExpenseVoided(tx: Transaction, ctx: PostingContext, a: { expenseId: string; date: string }) {
  await reverseBySource(tx, ctx, { sourceType: "expense", sourceId: a.expenseId, event: EVENTS.expense, entryDate: a.date, memo: "Expense voided" });
}

export async function postCashMovement(tx: Transaction, ctx: PostingContext, a: { movementId: string; date: string; kind: "withdrawal" | "bank_deposit" | "float_added"; amountPaise: number }) {
  await postJournal(tx, ctx, { entryDate: a.date, sourceType: "cash_movement", sourceId: a.movementId, draft: cashMoved({ kind: a.kind, amountPaise: a.amountPaise }) });
}

/** Damaged stock and count corrections. `qtyBase` is signed (negative = stock lost). */
export async function postStockAdjustment(tx: Transaction, ctx: PostingContext, a: { adjustmentId: string; date: string; line: CostedLine }) {
  await postJournal(tx, ctx, { entryDate: a.date, sourceType: "stock_adjustment", sourceId: a.adjustmentId, draft: stockAdjusted({ lines: [a.line] }) });
}

/**
 * An opening balance entered after the books started, for a party or stock. It posts when the opening journal already
 * exists or the entry is dated on or after the start date; otherwise the opening derivation (as at the start date) includes it,
 * so it is never counted twice. The other side waits in the clearing account until the owner confirms.
 */
async function lateOpeningApplies(tx: Transaction, ctx: PostingContext, effectiveDate: string) {
  const settings = await loadAccountingSettings(tx, ctx.shopId);
  if (!settings) return false;
  return effectiveDate >= settings.coverageStartDate || (await openingRecorded(tx, ctx.shopId));
}

export async function postPartyOpening(tx: Transaction, ctx: PostingContext, a: { sourceId: string; partyType: "customer" | "supplier"; partyId: string; effectiveDate: string; debitPaise: number; creditPaise: number }) {
  if (!(await lateOpeningApplies(tx, ctx, a.effectiveDate))) return;
  await postJournal(tx, ctx, { entryDate: indiaDate(), kind: "adjustment", sourceType: "opening_balance", sourceId: a.sourceId, memo: "Opening balance added after books started", draft: partyOpeningAdded({ partyType: a.partyType, partyId: a.partyId, debitPaise: a.debitPaise, creditPaise: a.creditPaise }) });
}

export async function postStockOpening(tx: Transaction, ctx: PostingContext, a: { batchId: string; effectiveDate: string; lines: CostedLine[] }) {
  if (!(await lateOpeningApplies(tx, ctx, a.effectiveDate))) return;
  await postJournal(tx, ctx, { entryDate: indiaDate(), kind: "adjustment", sourceType: "opening_stock", sourceId: a.batchId, memo: "Opening stock added after books started", draft: stockOpeningAdded({ lines: a.lines }) });
}

/** The GST account the receipt's own journal used, so a return reverses exactly that treatment. Falls back to the shop's current choice only if the receipt was never posted. */
async function receiptGstAccount(tx: Transaction, ctx: PostingContext, receiptId: string) {
  const [row] = await tx
    .select({ key: accounts.systemKey })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(eq(journals.shopId, ctx.shopId), eq(journals.sourceType, "goods_receipt"), eq(journals.sourceId, receiptId), eq(journals.event, EVENTS.goodsReceipt), like(accounts.systemKey, "gst_input%")))
    .limit(1);
  if (row) return row.key as "gst_input_recoverable" | "gst_input_review" | "gst_input_nonrecoverable";
  const settings = await loadAccountingSettings(tx, ctx.shopId);
  return inputGstAccount(settings?.inputGstPolicy ?? "review");
}

export async function postPurchaseReturn(tx: Transaction, ctx: PostingContext, a: { returnId: string; receiptId: string; date: string; supplierId: string; taxablePaise: number; gstPaise: number; totalPaise: number }) {
  const settings = await loadAccountingSettings(tx, ctx.shopId);
  if (!settings) return;
  await postJournal(tx, ctx, { entryDate: a.date, sourceType: "purchase_return", sourceId: a.returnId, draft: purchaseReturned({ supplierId: a.supplierId, taxablePaise: a.taxablePaise, gstPaise: a.gstPaise, totalPaise: a.totalPaise, gstAccount: await receiptGstAccount(tx, ctx, a.receiptId) }) });
}

/** Goods leaving on a delivery challan, and the same undone when an unbilled challan is cancelled. */
export async function postDelivery(tx: Transaction, ctx: PostingContext, a: { challanId: string; date: string; lines: CostedLine[] }) {
  await postJournal(tx, ctx, { entryDate: a.date, sourceType: "delivery_challan", sourceId: a.challanId, draft: goodsDelivered({ lines: a.lines }) });
}

export async function postDeliveryCancelled(tx: Transaction, ctx: PostingContext, a: { challanId: string; date: string }) {
  await reverseBySource(tx, ctx, { sourceType: "delivery_challan", sourceId: a.challanId, event: EVENTS.delivery, entryDate: a.date, memo: "Delivery cancelled" });
  await resolveGapsFor(tx, ctx, "delivery_challan", a.challanId);
}
