import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, ilike, sql, TransactionRollbackError, type SQL } from "drizzle-orm";
import { recordAudit } from "@/modules/audit";
import { loadProductNames, searchShopProducts } from "@/modules/catalog";
import { hasPermission, loadUserNames, requirePermission, type SessionContext } from "@/modules/identity";
import { appendStockMovement, lockStockRows, stockOnHand } from "@/modules/inventory";
import { appendLedgerEntry, lockPartyBalance, partyBalance } from "@/modules/ledger";
import { ensureWalkInCustomer, findCustomer, listActiveCustomers, loadCustomerNames } from "@/modules/parties";
import { paymentsForInvoice, recordCounterPayment, refundInvoicePayments } from "@/modules/payments";
import { getCurrentShop, takeDocumentNumber } from "@/modules/settings";
import { withIdempotency } from "@/modules/sync";
import { getDb, withTransaction } from "@/server/db";
import { ConflictError, NotFoundError } from "@/server/errors";
import { indiaDate } from "@/shared/financial-year";
import { formatQuantity, parseQuantity, toDbQuantity } from "@/shared/quantity";
import { billView, computeBill, type BillView } from "./bill";
import { BILLING_CREATE, BILLING_VIEW, INVOICE_CANCEL } from "./permissions";
import { invoiceLines, invoices } from "./schema";
import { billInputSchema, cancelInvoiceSchema, saveBillSchema } from "./validation";

const actorOf = (session: SessionContext) => ({ shopId: session.shopId, userId: session.userId, role: session.role });

/** Read-only bill preview for the counter. Writes nothing (the transaction is rolled back). */
export async function previewBill(session: SessionContext, input: unknown): Promise<BillView> {
  await requirePermission(session, BILLING_CREATE);
  const data = billInputSchema.parse(input);
  let view: BillView | undefined;
  try {
    await getDb().transaction(async (tx) => {
      await tx.execute(sql`set transaction read only`);
      view = billView(await computeBill(tx, session, data));
      tx.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) throw error;
  }
  return view!;
}

export type CreatedInvoice = { id: string; number: string; totalPaise: number; replayed: boolean };

/**
 * Saves a bill (spec §2 "What one saved bill writes"), all in one transaction:
 *   invoice + lines (rate, reason, cost at sale) · one SALE stock movement per line · payment rows ·
 *   for a registered customer, a ledger debit for the total and a credit per payment · audit row.
 *
 * Lock order (CLAUDE.md): stock_levels (product-id order) → party_balances → number_series.
 * Stock, prices, dues and the credit limit are re-checked after the locks. If any rate or the
 * total differs from what the cashier saw, nothing is saved and the new bill comes back.
 * The Idempotency-Key makes a repeated submit return the first invoice.
 */
export async function createInvoice(session: SessionContext, input: unknown): Promise<CreatedInvoice> {
  await requirePermission(session, BILLING_CREATE);
  const bill = billInputSchema.parse(input);
  const save = saveBillSchema.parse(input);
  const requestBody = {
    action: "sales.invoice",
    ...bill,
    lines: bill.lines.map((line) => ({ ...line, quantity: line.quantity.toString() })),
    expectedTotalPaise: save.expectedTotalPaise,
    expectedRates: save.expectedRates,
  };

  return withTransaction(async (tx) => {
    const outcome = await withIdempotency<Omit<CreatedInvoice, "replayed">>(tx, { shopId: session.shopId, userId: session.userId, key: save.idempotencyKey }, requestBody, async () => {
      await lockStockRows(tx, session.shopId, bill.lines.map((line) => line.productId));
      const chosen = bill.customerId ? await findCustomer(session.shopId, bill.customerId, tx) : null;
      const registered = chosen && chosen.type !== "walkin" ? chosen : null;
      if (registered) await lockPartyBalance(tx, session.shopId, "customer", registered.id);

      const computed = await computeBill(tx, session, bill);
      const view = billView(computed);
      const ratesChanged = view.expectedRates.length !== save.expectedRates.length || view.expectedRates.some((rate, index) => rate !== save.expectedRates[index]);
      if (ratesChanged || computed.totals.totalPaise !== save.expectedTotalPaise) {
        throw new ConflictError("PRICE_CHANGED", "Prices changed since this bill was shown. Check the new total and save again.", { bill: view });
      }
      const problem = computed.problems[0];
      if (problem) throw new ConflictError(problem.code, problem.message, { bill: view, problems: computed.problems });

      const customer = chosen ?? (await ensureWalkInCustomer(tx, session.shopId));
      const businessDate = indiaDate();
      const { fy, number } = await takeDocumentNumber(tx, session.shopId, "INV");
      const invoiceId = randomUUID();
      const totals = computed.totals;
      await tx.insert(invoices).values({
        id: invoiceId,
        shopId: session.shopId,
        fy,
        number,
        businessDate,
        customerId: customer.id,
        priceList: computed.priceList,
        createdBy: session.userId,
        subtotalPaise: totals.subtotalPaise,
        discountBp: totals.discountBp,
        discountPaise: totals.discountPaise,
        taxablePaise: totals.taxablePaise,
        cgstPaise: totals.cgstPaise,
        sgstPaise: totals.sgstPaise,
        igstPaise: totals.igstPaise,
        roundOffPaise: totals.roundOffPaise,
        totalPaise: totals.totalPaise,
        paidNowPaise: computed.paidNowPaise,
        costComplete: computed.costComplete,
      });
      await tx.insert(invoiceLines).values(
        computed.lines.map((line, index) => ({
          id: randomUUID(),
          invoiceId,
          lineNo: index + 1,
          productId: line.product.id,
          unit: line.saleUnit.code,
          factor: toDbQuantity(line.saleUnit.factor),
          qty: toDbQuantity(line.quote.quantity),
          baseQty: toDbQuantity(line.quote.baseQuantity),
          ratePaise: line.quote.saleUnitRatePaise,
          rateReason: line.rateReason,
          linePaise: line.quote.lineAmountPaise,
          lineDiscountPaise: totals.lines[index]!.discountPaise,
          taxablePaise: totals.lines[index]!.taxablePaise,
          gstRateBp: line.product.gstRateBp,
          cgstPaise: totals.lines[index]!.cgstPaise,
          sgstPaise: totals.lines[index]!.sgstPaise,
          unitCostPaise: line.product.costPaise,
        })),
      );
      for (const line of computed.lines) {
        await appendStockMovement(tx, {
          shopId: session.shopId,
          productId: line.product.id,
          movementDate: businessDate,
          kind: "sale",
          qtyBase: -line.quote.baseQuantity,
          unitCostPaise: line.product.costPaise,
          sourceType: "invoice",
          sourceId: invoiceId,
          reason: number,
          createdBy: session.userId,
        });
      }
      if (registered) {
        await appendLedgerEntry(tx, { shopId: session.shopId, partyType: "customer", partyId: registered.id, entryDate: businessDate, kind: "invoice", sourceType: "invoice", sourceId: invoiceId, debitPaise: totals.totalPaise });
      }
      for (const method of ["cash", "upi", "card", "bank"] as const) {
        const amount = bill.payments[method];
        if (amount <= 0) continue;
        const paymentId = await recordCounterPayment(tx, { shopId: session.shopId, fy, customerId: registered?.id ?? null, invoiceId, method, amountPaise: amount, businessDate, recordedBy: session.userId });
        if (registered) {
          await appendLedgerEntry(tx, { shopId: session.shopId, partyType: "customer", partyId: registered.id, entryDate: businessDate, kind: "payment", sourceType: "payment", sourceId: paymentId, creditPaise: amount });
        }
      }
      await recordAudit(tx, actorOf(session), {
        action: "sales.invoice_issued",
        entityType: "invoice",
        entityId: invoiceId,
        after: {
          number,
          customerId: customer.id,
          priceList: computed.priceList,
          totalPaise: totals.totalPaise,
          discountBp: totals.discountBp,
          paidNowPaise: computed.paidNowPaise,
          methods: Object.fromEntries(Object.entries(bill.payments).filter(([, amount]) => amount > 0)),
          creditPaise: computed.creditPaise,
          lines: computed.lines.length,
        },
      });
      return { status: 201, body: { id: invoiceId, number, totalPaise: totals.totalPaise } };
    });
    return { ...outcome.body, replayed: outcome.replayed };
  });
}

/**
 * Cancels a bill (decision 20: owner only, same business day). Nothing is deleted or edited except
 * the invoice's status: stock comes back with SALE_CANCEL movements, every payment is refunded by
 * the same method (new "out" rows), and the customer ledger gets a cancellation credit for the
 * total and a debit per refund, so the net effect on dues is zero.
 */
export async function cancelInvoice(session: SessionContext, invoiceId: string, input: unknown): Promise<void> {
  await requirePermission(session, INVOICE_CANCEL);
  const { reason } = cancelInvoiceSchema.parse(input);
  if (!/^[0-9a-f-]{36}$/i.test(invoiceId)) throw new NotFoundError("Bill not found.");
  await withTransaction(async (tx) => {
    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.shopId, session.shopId)))
      .limit(1)
      .for("update");
    if (!invoice) throw new NotFoundError("Bill not found.");
    if (invoice.status === "cancelled") throw new ConflictError("ALREADY_CANCELLED", "This bill is already cancelled.");
    const today = indiaDate();
    if (invoice.businessDate !== today) throw new ConflictError("NOT_SAME_DAY", "Only today's bills can be cancelled. For an older bill, issue a credit note (coming in a later update).");

    const lines = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoice.id)).orderBy(asc(invoiceLines.lineNo));
    await lockStockRows(tx, session.shopId, lines.map((line) => line.productId));
    const customer = await findCustomer(session.shopId, invoice.customerId, tx);
    const registered = customer.type !== "walkin";
    if (registered) await lockPartyBalance(tx, session.shopId, "customer", customer.id);

    await tx.update(invoices).set({ status: "cancelled", cancelledAt: new Date(), cancelledBy: session.userId, cancelReason: reason }).where(eq(invoices.id, invoice.id));
    for (const line of lines) {
      await appendStockMovement(tx, {
        shopId: session.shopId,
        productId: line.productId,
        movementDate: today,
        kind: "sale_cancel",
        qtyBase: parseQuantity(line.baseQty),
        unitCostPaise: line.unitCostPaise,
        sourceType: "invoice",
        sourceId: invoice.id,
        reason: `Cancelled ${invoice.number}: ${reason}`,
        createdBy: session.userId,
      });
    }
    if (registered) {
      await appendLedgerEntry(tx, { shopId: session.shopId, partyType: "customer", partyId: customer.id, entryDate: today, kind: "cancellation", sourceType: "invoice", sourceId: invoice.id, creditPaise: invoice.totalPaise });
    }
    const refunds = await refundInvoicePayments(tx, { shopId: session.shopId, fy: invoice.fy, invoiceId: invoice.id, customerId: registered ? customer.id : null, businessDate: today, recordedBy: session.userId });
    if (registered) {
      for (const refund of refunds) {
        await appendLedgerEntry(tx, { shopId: session.shopId, partyType: "customer", partyId: customer.id, entryDate: today, kind: "payment", sourceType: "payment", sourceId: refund.id, debitPaise: refund.amountPaise });
      }
    }
    await recordAudit(tx, actorOf(session), {
      action: "sales.invoice_cancelled",
      entityType: "invoice",
      entityId: invoice.id,
      before: { status: invoice.status },
      after: { status: "cancelled", number: invoice.number, refundedPaise: refunds.reduce((sum, refund) => sum + refund.amountPaise, 0) },
      reason,
    });
  });
}


// ── Reading ──────────────────────────────────────────────────────────────────

export async function getInvoice(session: SessionContext, invoiceId: string) {
  await requirePermission(session, BILLING_VIEW);
  if (!/^[0-9a-f-]{36}$/i.test(invoiceId)) throw new NotFoundError("Bill not found.");
  const db = getDb();
  const [invoice] = await db.select().from(invoices).where(and(eq(invoices.id, invoiceId), eq(invoices.shopId, session.shopId))).limit(1);
  if (!invoice) throw new NotFoundError("Bill not found.");
  const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoice.id)).orderBy(asc(invoiceLines.lineNo));
  const [products, customer, payments, users, shop, canCancel] = await Promise.all([
    loadProductNames(session.shopId, lines.map((line) => line.productId)),
    findCustomer(session.shopId, invoice.customerId),
    paymentsForInvoice(db, session.shopId, invoice.id),
    loadUserNames(session.shopId, [invoice.createdBy, ...(invoice.cancelledBy ? [invoice.cancelledBy] : [])]),
    getCurrentShop(session),
    hasPermission(session, INVOICE_CANCEL),
  ]);
  const balanceNowPaise = customer.type === "walkin" ? null : await partyBalance(session.shopId, "customer", customer.id);
  // Cost fields stay on the server: profit is not part of billing.
  const header = { ...invoice, costComplete: undefined };
  return {
    ...header,
    shop,
    customer: { id: customer.id, name: customer.name, type: customer.type, phone: customer.phone, gstin: customer.gstin, area: customer.area },
    lines: lines.map((line) => ({
      ...line,
      unitCostPaise: undefined,
      productName: products.get(line.productId)?.name ?? "Unknown product",
      baseUnit: products.get(line.productId)?.baseUnit ?? "",
      qty: formatQuantity(parseQuantity(line.qty)),
      baseQty: formatQuantity(parseQuantity(line.baseQty)),
      factor: formatQuantity(parseQuantity(line.factor)),
    })),
    payments,
    createdByName: users.get(invoice.createdBy) ?? "Unknown user",
    cancelledByName: invoice.cancelledBy ? (users.get(invoice.cancelledBy) ?? "Unknown user") : null,
    balanceNowPaise,
    canCancel: canCancel && invoice.status === "issued" && invoice.businessDate === indiaDate(),
  };
}

export const INVOICE_PAGE_SIZE = 50;

export async function listInvoices(session: SessionContext, filters: { q?: string; date?: string; page?: number } = {}) {
  await requirePermission(session, BILLING_VIEW);
  const conditions: (SQL | undefined)[] = [eq(invoices.shopId, session.shopId)];
  if (filters.date && /^\d{4}-\d{2}-\d{2}$/.test(filters.date)) conditions.push(eq(invoices.businessDate, filters.date));
  const q = filters.q?.trim().slice(0, 40);
  if (q) conditions.push(ilike(invoices.number, `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`));
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const rows = await getDb()
    .select({ id: invoices.id, number: invoices.number, businessDate: invoices.businessDate, customerId: invoices.customerId, totalPaise: invoices.totalPaise, paidNowPaise: invoices.paidNowPaise, status: invoices.status, createdAt: invoices.createdAt })
    .from(invoices)
    .where(and(...conditions))
    .orderBy(desc(invoices.createdAt))
    .limit(INVOICE_PAGE_SIZE + 1)
    .offset((page - 1) * INVOICE_PAGE_SIZE);
  const customers = await loadCustomerNames(session.shopId, [...new Set(rows.map((row) => row.customerId))]);
  return { items: rows.slice(0, INVOICE_PAGE_SIZE).map((row) => ({ ...row, customerName: customers.get(row.customerId) ?? "Customer" })), page, hasMore: rows.length > INVOICE_PAGE_SIZE };
}

/** Products the counter can add: active, with units, list prices (shown only as a hint) and stock on hand. */
export async function searchSellableProducts(session: SessionContext, q: string) {
  await requirePermission(session, BILLING_CREATE);
  const page = await searchShopProducts(session.shopId, { q, status: "active" });
  const stock = await stockOnHand(session.shopId, page.items.map((item) => item.id));
  return page.items.slice(0, 20).map((item) => ({
    id: item.id,
    name: item.name,
    sku: item.sku,
    baseUnit: item.baseUnit,
    baseUnitName: item.baseUnitName,
    units: [{ code: item.baseUnit, label: item.baseUnitName }, ...item.conversions.map((conversion) => ({ code: conversion.unit, label: `${conversion.unitName} of ${conversion.factor}` }))],
    stockQty: stock.has(item.id) ? formatQuantity(stock.get(item.id)!.qty) : null,
  }));
}

export async function listBillingCustomers(session: SessionContext) {
  await requirePermission(session, BILLING_CREATE);
  const customers = await listActiveCustomers(session.shopId);
  return customers.filter((customer) => customer.type !== "walkin").map((customer) => ({ id: customer.id, name: customer.name, type: customer.type, area: customer.area }));
}
