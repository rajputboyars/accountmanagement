import { randomUUID } from "node:crypto";
import { documentParties, printedSeller } from "./document-parties";
import { and, asc, desc, eq, ilike, inArray, is, sql, TransactionRollbackError, type SQL } from "drizzle-orm";
import { recordAudit } from "@/modules/audit";
import { loadProductNames, loadProductsForStock } from "@/modules/catalog";
import { loadUserNames, requirePermission, type SessionContext } from "@/modules/identity";
import { appendStockMovement, lockStockRows } from "@/modules/inventory";
import { appendLedgerEntry, lockPartyBalance, partyBalance } from "@/modules/ledger";
import { findCustomer, loadCustomerNames } from "@/modules/parties";
import { recordCreditNoteRefund } from "@/modules/payments";
import { invoiceProfile, takeDocumentNumber } from "@/modules/settings";
import { withIdempotency } from "@/modules/sync";
import { getDb, withTransaction, type Database, type Transaction } from "@/server/db";
import { lockDayForWrite } from "@/server/day-lock";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import { computeCreditNote, ReturnQuantityError, type CreditNoteTotals } from "@/shared/credit-note";
import { indiaDate } from "@/shared/financial-year";
import { formatQuantity, isWholeQuantity, parseQuantity, toDbQuantity, type Milli } from "@/shared/quantity";
import { BILLING_RETURN, BILLING_VIEW } from "./permissions";
import { creditNoteLines, creditNotes, invoiceLines, invoices } from "./schema";
import { returnInputSchema, saveReturnSchema } from "./validation";

/**
 * Customer returns against an invoice (spec §5, scenario S4): a numbered credit note
 * (CN/26-27/00001) for the returned quantity, valued at the original line's discounted taxable
 * value plus GST. The invoice is never edited. Saleable goods come back into stock (RETURN_IN);
 * damaged goods are received and written off in the same transaction (RETURN_IN then DAMAGE), so
 * stock is unchanged but the loss is on record. Settlement: reduce the customer's dues (ledger
 * credit) or pay the money back (cash/UPI/bank refund row; for a registered customer the ledger also
 * gets the matching debit, so dues are unchanged and the money went back instead).
 *
 * Lock order: the invoice row (document) → stock_levels → party_balances → number_series. Locking the
 * invoice first serialises every return of that bill, so two returns can't both take the last units.
 */

const actorOf = (session: SessionContext) => ({ shopId: session.shopId, userId: session.userId, role: session.role });
type Db = Database | Transaction;

type ReturnableLine = {
  id: string;
  lineNo: number;
  productId: string;
  productName: string;
  baseUnit: string;
  baseAllowsDecimal: boolean;
  unit: string;
  qty: string;
  soldBaseQty: Milli;
  returnedBaseQty: Milli;
  returnedTaxablePaise: number;
  taxablePaise: number;
  gstRateBp: number;
  ratePaise: number;
  unitCostPaise: number | null;
};

async function loadReturnable(db: Db, shopId: string, invoice: typeof invoices.$inferSelect): Promise<ReturnableLine[]> {
  const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoice.id)).orderBy(asc(invoiceLines.lineNo));
  const returned = await db
    .select({ invoiceLineId: creditNoteLines.invoiceLineId, qty: sql<string>`sum(${creditNoteLines.baseQty})::text`, taxable: sql<string>`sum(${creditNoteLines.taxablePaise})::text` })
    .from(creditNoteLines)
    .where(inArray(creditNoteLines.invoiceLineId, lines.length ? lines.map((line) => line.id) : ["00000000-0000-0000-0000-000000000000"]))
    .groupBy(creditNoteLines.invoiceLineId);
  const byLine = new Map(returned.map((row) => [row.invoiceLineId, row]));
  const products = new Map((await loadProductsForStock(shopId, [...new Set(lines.map((line) => line.productId))], db)).map((product) => [product.id, product]));
  return lines.map((line) => {
    const product = products.get(line.productId);
    const done = byLine.get(line.id);
    return {
      id: line.id,
      lineNo: line.lineNo,
      productId: line.productId,
      productName: product?.name ?? "Unknown product",
      baseUnit: product?.baseUnit ?? "",
      baseAllowsDecimal: product?.baseAllowsDecimal ?? false,
      unit: line.unit,
      qty: formatQuantity(parseQuantity(line.qty)),
      soldBaseQty: parseQuantity(line.baseQty),
      returnedBaseQty: done ? parseQuantity(done.qty) : BigInt(0),
      returnedTaxablePaise: done ? Number(done.taxable) : 0,
      taxablePaise: line.taxablePaise,
      gstRateBp: line.gstRateBp,
      ratePaise: line.ratePaise,
      unitCostPaise: line.unitCostPaise,
    };
  });
}

async function findInvoice(db: Db, shopId: string, invoiceId: string, lock = false) {
  if (!/^[0-9a-f-]{36}$/i.test(invoiceId)) throw new NotFoundError("Bill not found.");
  const query = db.select().from(invoices).where(and(eq(invoices.id, invoiceId), eq(invoices.shopId, shopId))).limit(1);
  const [invoice] = lock ? await query.for("update") : await query;
  if (!invoice) throw new NotFoundError("Bill not found.");
  return invoice;
}

/** A bill with what is left to return on each line, for the return screen. */
export async function getReturnableInvoice(session: SessionContext, invoiceId: string) {
  await requirePermission(session, BILLING_RETURN);
  const db = getDb();
  const invoice = await findInvoice(db, session.shopId, invoiceId);
  const [lines, customer] = await Promise.all([loadReturnable(db, session.shopId, invoice), findCustomer(session.shopId, invoice.customerId)]);
  return {
    id: invoice.id,
    number: invoice.number,
    businessDate: invoice.businessDate,
    status: invoice.status,
    totalPaise: invoice.totalPaise,
    customer: { id: customer.id, name: customer.name, type: customer.type },
    lines: lines.map((line) => ({
      id: line.id,
      lineNo: line.lineNo,
      productName: line.productName,
      baseUnit: line.baseUnit,
      baseAllowsDecimal: line.baseAllowsDecimal,
      sold: `${line.qty} ${line.unit}`,
      soldBaseQty: formatQuantity(line.soldBaseQty),
      returnedBaseQty: formatQuantity(line.returnedBaseQty),
      remainingBaseQty: formatQuantity(line.soldBaseQty - line.returnedBaseQty),
      ratePaise: line.ratePaise,
    })),
  };
}

/** Finds a bill by its number (e.g. "INV/26-27/00012" or just "12") in this shop. */
export async function findInvoiceByNumber(session: SessionContext, number: string): Promise<{ id: string; number: string } | null> {
  await requirePermission(session, BILLING_RETURN);
  const text = number.trim();
  if (!text) return null;
  const digits = /^\d{1,5}$/.test(text) ? text.padStart(5, "0") : null;
  const condition = digits ? ilike(invoices.number, `%/${digits}`) : eq(invoices.number, text.toUpperCase());
  const [row] = await getDb().select({ id: invoices.id, number: invoices.number }).from(invoices).where(and(eq(invoices.shopId, session.shopId), condition)).orderBy(desc(invoices.createdAt)).limit(1);
  return row ?? null;
}

type Parsed = ReturnType<typeof returnInputSchema.parse>;

type Planned = { invoice: typeof invoices.$inferSelect; customer: Awaited<ReturnType<typeof findCustomer>>; lines: (ReturnableLine & { returnBaseQty: Milli; restock: boolean })[]; totals: CreditNoteTotals };

/** Checks a return against the bill and works out the credit note. Throws on the first problem. */
async function planReturn(db: Db, shopId: string, data: Parsed, lockInvoice: boolean): Promise<Planned> {
  const invoice = await findInvoice(db, shopId, data.invoiceId, lockInvoice);
  if (invoice.status === "cancelled") throw new ConflictError("INVOICE_CANCELLED", "This bill was cancelled, so nothing on it can be returned.");
  const customer = await findCustomer(shopId, invoice.customerId, db);
  if (data.settlement === "ledger" && customer.type === "walkin") {
    throw new ValidationError("A walk-in customer has no account. Refund the money by cash, UPI or bank.", { fieldErrors: { settlement: "Choose cash, UPI or bank for a walk-in customer." } });
  }
  const returnable = new Map((await loadReturnable(db, shopId, invoice)).map((line) => [line.id, line]));
  const lines = data.lines.map((request, index) => {
    const line = returnable.get(request.invoiceLineId);
    if (!line) throw new ValidationError("That item is not on this bill.", { fieldErrors: { [`lines.${index}.baseQty`]: "Not on this bill." } });
    if (!line.baseAllowsDecimal && !isWholeQuantity(request.baseQty)) {
      throw new ValidationError(`${line.productName} can't be split: return a whole number of ${line.baseUnit}.`, { fieldErrors: { [`lines.${index}.baseQty`]: "Whole numbers only." } });
    }
    return { ...line, returnBaseQty: request.baseQty, restock: request.restock };
  });
  let totals: CreditNoteTotals;
  try {
    totals = computeCreditNote(lines.map((line) => ({ soldBaseQty: line.soldBaseQty, lineTaxablePaise: line.taxablePaise, gstRateBp: line.gstRateBp, returnedBaseQty: line.returnedBaseQty, returnedTaxablePaise: line.returnedTaxablePaise, returnBaseQty: line.returnBaseQty })), invoice.taxMode);
  } catch (error) {
    if (error instanceof ReturnQuantityError) {
      const line = lines[error.lineIndex]!;
      throw new ConflictError("OVER_RETURN", `Only ${formatQuantity(line.soldBaseQty - line.returnedBaseQty)} ${line.baseUnit} of ${line.productName} are left to return on this bill.`, {
        fieldErrors: { [`lines.${error.lineIndex}.baseQty`]: `At most ${formatQuantity(line.soldBaseQty - line.returnedBaseQty)} ${line.baseUnit}.` },
      });
    }
    throw error;
  }
  return { invoice, customer, lines, totals };
}

function returnView(plan: Planned) {
  return {
    invoiceId: plan.invoice.id,
    invoiceNumber: plan.invoice.number,
    customer: { id: plan.customer.id, name: plan.customer.name, type: plan.customer.type },
    lines: plan.lines.map((line, index) => ({
      invoiceLineId: line.id,
      productName: line.productName,
      baseQty: formatQuantity(line.returnBaseQty),
      baseUnit: line.baseUnit,
      restock: line.restock,
      taxablePaise: plan.totals.lines[index]!.taxablePaise,
      gstRateBp: line.gstRateBp,
    })),
    taxablePaise: plan.totals.taxablePaise,
    cgstPaise: plan.totals.cgstPaise,
    sgstPaise: plan.totals.sgstPaise,
    igstPaise: plan.totals.igstPaise,
    taxMode: plan.invoice.taxMode,
    roundOffPaise: plan.totals.roundOffPaise,
    totalPaise: plan.totals.totalPaise,
  };
}

export type ReturnPreview = ReturnType<typeof returnView>;

/** Read-only: what the credit note would be. Writes nothing. */
export async function previewReturn(session: SessionContext, input: unknown): Promise<ReturnPreview> {
  await requirePermission(session, BILLING_RETURN);
  const data = returnInputSchema.parse(input);
  let view: ReturnPreview | undefined;
  try {
    await getDb().transaction(async (tx) => {
      await tx.execute(sql`set transaction read only`);
      view = returnView(await planReturn(tx, session.shopId, data, false));
      tx.rollback();
    });
  } catch (error) {
    if (!is(error, TransactionRollbackError)) throw error; // instanceof misses it when the bundle loads two copies of drizzle
  }
  return view!;
}

export type CreatedCreditNote = { id: string; number: string; totalPaise: number; replayed: boolean };

export async function createReturn(session: SessionContext, input: unknown): Promise<CreatedCreditNote> {
  await requirePermission(session, BILLING_RETURN);
  const data = returnInputSchema.parse(input);
  const save = saveReturnSchema.parse(input);
  const body = { action: "sales.return", ...data, lines: data.lines.map((line) => ({ ...line, baseQty: line.baseQty.toString() })), expectedTotalPaise: save.expectedTotalPaise };

  return withTransaction(async (tx) => {
    const outcome = await withIdempotency<Omit<CreatedCreditNote, "replayed">>(tx, { shopId: session.shopId, userId: session.userId, key: save.idempotencyKey }, body, async () => {
      await lockDayForWrite(tx, session.shopId, indiaDate());
      const plan = await planReturn(tx, session.shopId, data, true);
      if (plan.totals.totalPaise !== save.expectedTotalPaise) {
        throw new ConflictError("RETURN_CHANGED", "This bill changed since the return was shown (another return may have been saved). Check the new amount and save again.", { preview: returnView(plan) });
      }
      const registered = plan.customer.type !== "walkin";
      await lockStockRows(tx, session.shopId, plan.lines.map((line) => line.productId));
      if (registered) await lockPartyBalance(tx, session.shopId, "customer", plan.customer.id);
      const { fy, number } = await takeDocumentNumber(tx, session.shopId, "CN");
      const today = indiaDate();
      const creditNoteId = randomUUID();
      await tx.insert(creditNotes).values({
        id: creditNoteId,
        shopId: session.shopId,
        fy,
        number,
        invoiceId: plan.invoice.id,
        customerId: plan.customer.id,
        businessDate: today,
        reason: data.reason,
        ...(await documentParties(tx, session.shopId, plan.customer)),
        settlement: data.settlement,
        taxablePaise: plan.totals.taxablePaise,
        cgstPaise: plan.totals.cgstPaise,
        sgstPaise: plan.totals.sgstPaise,
        igstPaise: plan.totals.igstPaise,
        roundOffPaise: plan.totals.roundOffPaise,
        totalPaise: plan.totals.totalPaise,
        createdBy: session.userId,
      });
      await tx.insert(creditNoteLines).values(
        plan.lines.map((line, index) => ({
          id: randomUUID(),
          creditNoteId,
          invoiceLineId: line.id,
          baseQty: toDbQuantity(line.returnBaseQty),
          taxablePaise: plan.totals.lines[index]!.taxablePaise,
          cgstPaise: plan.totals.lines[index]!.cgstPaise,
          sgstPaise: plan.totals.lines[index]!.sgstPaise,
          igstPaise: plan.totals.lines[index]!.igstPaise,
          restock: line.restock,
        })),
      );
      for (const line of plan.lines) {
        const movement = { shopId: session.shopId, productId: line.productId, movementDate: today, unitCostPaise: line.unitCostPaise, sourceType: "credit_note", sourceId: creditNoteId, createdBy: session.userId };
        await appendStockMovement(tx, { ...movement, kind: "return_in", qtyBase: line.returnBaseQty, reason: `${number}: ${data.reason}` });
        if (!line.restock) await appendStockMovement(tx, { ...movement, kind: "damage", qtyBase: -line.returnBaseQty, reason: `${number}: returned damaged` });
      }
      if (registered) {
        await appendLedgerEntry(tx, { shopId: session.shopId, partyType: "customer", partyId: plan.customer.id, entryDate: today, kind: "credit_note", sourceType: "credit_note", sourceId: creditNoteId, creditPaise: plan.totals.totalPaise });
      }
      if (data.settlement !== "ledger" && plan.totals.totalPaise > 0) {
        const paymentId = await recordCreditNoteRefund(tx, {
          shopId: session.shopId,
          fy,
          customerId: registered ? plan.customer.id : null,
          invoiceId: plan.invoice.id,
          creditNoteId,
          method: data.settlement,
          amountPaise: plan.totals.totalPaise,
          businessDate: today,
          recordedBy: session.userId,
        });
        if (registered) {
          await appendLedgerEntry(tx, { shopId: session.shopId, partyType: "customer", partyId: plan.customer.id, entryDate: today, kind: "payment", sourceType: "payment", sourceId: paymentId, debitPaise: plan.totals.totalPaise });
        }
      }
      await recordAudit(tx, actorOf(session), {
        action: "sales.credit_note_issued",
        entityType: "credit_note",
        entityId: creditNoteId,
        after: {
          number,
          invoiceNumber: plan.invoice.number,
          settlement: data.settlement,
          totalPaise: plan.totals.totalPaise,
          lines: plan.lines.map((line) => ({ invoiceLineId: line.id, baseQty: formatQuantity(line.returnBaseQty), restock: line.restock })),
        },
        reason: data.reason,
      });
      return { status: 201, body: { id: creditNoteId, number, totalPaise: plan.totals.totalPaise } };
    });
    return { ...outcome.body, replayed: outcome.replayed };
  });
}

// ── Reading ──────────────────────────────────────────────────────────────────

export const CREDIT_NOTE_PAGE_SIZE = 50;

export async function listCreditNotes(session: SessionContext, filters: { q?: string; page?: number; invoiceId?: string } = {}) {
  await requirePermission(session, BILLING_VIEW);
  const conditions: (SQL | undefined)[] = [eq(creditNotes.shopId, session.shopId)];
  if (filters.invoiceId && /^[0-9a-f-]{36}$/i.test(filters.invoiceId)) conditions.push(eq(creditNotes.invoiceId, filters.invoiceId));
  const q = filters.q?.trim().slice(0, 40);
  if (q) conditions.push(ilike(creditNotes.number, `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`));
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const rows = await getDb()
    .select({ id: creditNotes.id, number: creditNotes.number, businessDate: creditNotes.businessDate, invoiceId: creditNotes.invoiceId, invoiceNumber: invoices.number, customerId: creditNotes.customerId, settlement: creditNotes.settlement, totalPaise: creditNotes.totalPaise, reason: creditNotes.reason })
    .from(creditNotes)
    .innerJoin(invoices, eq(invoices.id, creditNotes.invoiceId))
    .where(and(...conditions))
    .orderBy(desc(creditNotes.createdAt))
    .limit(CREDIT_NOTE_PAGE_SIZE + 1)
    .offset((page - 1) * CREDIT_NOTE_PAGE_SIZE);
  const names = await loadCustomerNames(session.shopId, [...new Set(rows.map((row) => row.customerId))]);
  return { items: rows.slice(0, CREDIT_NOTE_PAGE_SIZE).map((row) => ({ ...row, customerName: names.get(row.customerId) ?? "Customer" })), page, hasMore: rows.length > CREDIT_NOTE_PAGE_SIZE };
}

export async function getCreditNote(session: SessionContext, creditNoteId: string) {
  await requirePermission(session, BILLING_VIEW);
  if (!/^[0-9a-f-]{36}$/i.test(creditNoteId)) throw new NotFoundError("Credit note not found.");
  const db = getDb();
  const [note] = await db.select().from(creditNotes).where(and(eq(creditNotes.id, creditNoteId), eq(creditNotes.shopId, session.shopId))).limit(1);
  if (!note) throw new NotFoundError("Credit note not found.");
  const [invoice] = await db.select({ number: invoices.number, businessDate: invoices.businessDate }).from(invoices).where(eq(invoices.id, note.invoiceId));
  const lines = await db
    .select({ id: creditNoteLines.id, baseQty: creditNoteLines.baseQty, taxablePaise: creditNoteLines.taxablePaise, cgstPaise: creditNoteLines.cgstPaise, sgstPaise: creditNoteLines.sgstPaise, restock: creditNoteLines.restock, productId: invoiceLines.productId, gstRateBp: invoiceLines.gstRateBp, lineNo: invoiceLines.lineNo })
    .from(creditNoteLines)
    .innerJoin(invoiceLines, eq(invoiceLines.id, creditNoteLines.invoiceLineId))
    .where(eq(creditNoteLines.creditNoteId, note.id))
    .orderBy(asc(invoiceLines.lineNo));
  const [original] = await db.select({ taxMode: invoices.taxMode, placeOfSupply: invoices.placeOfSupply }).from(invoices).where(and(eq(invoices.id, note.invoiceId), eq(invoices.shopId, session.shopId))).limit(1);
  const [products, customer, users, shop] = await Promise.all([
    loadProductNames(session.shopId, lines.map((line) => line.productId)),
    findCustomer(session.shopId, note.customerId),
    loadUserNames(session.shopId, [note.createdBy]),
    invoiceProfile(session.shopId),
  ]);
  return {
    ...note,
    invoiceNumber: invoice?.number ?? "",
    invoiceDate: invoice?.businessDate ?? "",
    shop: printedSeller(shop, note.seller),
    taxMode: original?.taxMode ?? "intra",
    placeOfSupply: original?.placeOfSupply ?? null,
    customer: { id: customer.id, type: customer.type, name: customer.name, phone: customer.phone, gstin: customer.gstin, ...(note.buyer ?? {}) },
    lines: lines.map((line) => ({ ...line, baseQty: formatQuantity(parseQuantity(line.baseQty)), productName: products.get(line.productId)?.name ?? "Unknown product", baseUnit: products.get(line.productId)?.baseUnit ?? "" })),
    createdByName: users.get(note.createdBy) ?? "Unknown user",
    balanceNowPaise: customer.type === "walkin" ? null : await partyBalance(session.shopId, "customer", customer.id),
  };
}
