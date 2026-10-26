import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, ilike, sql, TransactionRollbackError, type SQL } from "drizzle-orm";
import { recordAudit } from "@/modules/audit";
import { loadProductNames, searchShopProducts } from "@/modules/catalog";
import { ANY_TARGET, consumeApproval, consumeMatchingApproval, hasPermission, loadUserNames, requirePermission, verifyOwnerPin, type SessionContext } from "@/modules/identity";
import { appendStockMovement, lockStockRows, stockOnHand } from "@/modules/inventory";
import { appendLedgerEntry, lockPartyBalance, partyBalance } from "@/modules/ledger";
import { ensureWalkInCustomer, findCustomer, listActiveCustomers, loadCustomerNames } from "@/modules/parties";
import { paymentsForInvoice, recordCounterPayment, refundInvoicePayments } from "@/modules/payments";
import { invoiceProfile, takeDocumentNumber } from "@/modules/settings";
import { withIdempotency } from "@/modules/sync";
import { getDb, withTransaction, type Transaction } from "@/server/db";
import { lockDayForWrite } from "@/server/day-lock";
import { ConflictError, NotFoundError } from "@/server/errors";
import { indiaDate } from "@/shared/financial-year";
import { formatQuantity, parseQuantity, toDbQuantity } from "@/shared/quantity";
import { billView, computeBill, type BillView } from "./bill";
import { BILLING_CREATE, BILLING_RETURN, BILLING_VIEW, INVOICE_CANCEL } from "./permissions";
import { creditNotes, invoiceLines, invoices } from "./schema";
import { billInputSchema, cancelInvoiceSchema, correctInvoiceSchema, saveBillSchema } from "./validation";

const actorOf = (session: SessionContext) => ({ shopId: session.shopId, userId: session.userId, role: session.role });

type SaveInput = ReturnType<typeof saveBillSchema.parse>;
type ParsedBill = ReturnType<typeof billInputSchema.parse>;

/**
 * Prices the bill under the normal role and credit limits. If it is over a limit, applies the owner's
 * authority for this one bill (handoff §2.3): the owner PIN typed now, or an approval the owner gave this
 * user for this customer, covering this discount % or these dues (an explicit id, or the oldest matching
 * one). The approval raises the limit only to what was approved and is marked used inside this
 * transaction, so a rollback leaves it unused. Problems that remain are left for the caller to throw.
 */
async function computeWithApprovals(tx: Transaction, session: SessionContext, bill: ParsedBill, save: SaveInput, registeredId: string | null) {
  const options: { discountLimitBp?: number; creditLimitPaise?: number } = {};
  if (save.ownerPin) {
    await verifyOwnerPin(session, save.ownerPin);
    options.discountLimitBp = 10_000;
    options.creditLimitPaise = Number.MAX_SAFE_INTEGER;
  }
  let computed = await computeBill(tx, session, bill, options);
  let discountApprovalId: string | null = null;
  let creditApprovalId: string | null = null;
  if (computed.problems.some((problem) => problem.code === "DISCOUNT_APPROVAL_REQUIRED")) {
    const refs = registeredId ? [registeredId, ANY_TARGET] : [ANY_TARGET];
    const covers = (payload: { limitBp?: number | null }) => ((payload.limitBp ?? 0) >= bill.discountPercent ? null : "The approved discount is lower than the discount on this bill.");
    const used = save.discountApprovalId ? await consumeApproval(tx, session, save.discountApprovalId, "discount_over_limit", refs, covers) : await consumeMatchingApproval(tx, session, "discount_over_limit", refs, covers);
    if (used) {
      discountApprovalId = used.id;
      options.discountLimitBp = used.payload.limitBp ?? 0;
    }
  }
  if (registeredId && computed.problems.some((problem) => problem.code === "CREDIT_LIMIT")) {
    const after = computed.balanceAfterPaise ?? 0;
    const covers = (payload: { amountPaise?: number | null }) => ((payload.amountPaise ?? 0) >= after ? null : "The approved dues are lower than this bill needs.");
    const used = save.creditApprovalId ? await consumeApproval(tx, session, save.creditApprovalId, "credit_over_limit", [registeredId], covers) : await consumeMatchingApproval(tx, session, "credit_over_limit", [registeredId], covers);
    if (used) {
      creditApprovalId = used.id;
      options.creditLimitPaise = used.payload.amountPaise ?? 0;
    }
  }
  if (discountApprovalId || creditApprovalId) computed = await computeBill(tx, session, bill, options);
  return { computed, discountApprovalId, creditApprovalId };
}


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
      await lockDayForWrite(tx, session.shopId, indiaDate());
      await lockStockRows(tx, session.shopId, bill.lines.map((line) => line.productId));
      const chosen = bill.customerId ? await findCustomer(session.shopId, bill.customerId, tx) : null;
      const registered = chosen && chosen.type !== "walkin" ? chosen : null;
      if (registered) await lockPartyBalance(tx, session.shopId, "customer", registered.id);

      const { computed, discountApprovalId: consumedDiscountApprovalId, creditApprovalId: consumedCreditApprovalId } = await computeWithApprovals(tx, session, bill, save, registered?.id ?? null);
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
        taxMode: computed.taxMode,
        placeOfSupply: computed.placeOfSupply,
        discountApprovalId: consumedDiscountApprovalId,
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
          gstRateBp: totals.lines[index]!.gstRateBp,
          cgstPaise: totals.lines[index]!.cgstPaise,
          sgstPaise: totals.lines[index]!.sgstPaise,
          igstPaise: totals.lines[index]!.igstPaise,
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
        approvalId: consumedDiscountApprovalId ?? consumedCreditApprovalId ?? null,
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
    await lockDayForWrite(tx, session.shopId, indiaDate());
    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.shopId, session.shopId)))
      .limit(1)
      .for("update");
    if (!invoice) throw new NotFoundError("Bill not found.");
    if (invoice.status === "cancelled") throw new ConflictError("ALREADY_CANCELLED", "This bill is already cancelled.");
    const today = indiaDate();
    if (invoice.businessDate !== today) throw new ConflictError("NOT_SAME_DAY", "Only today's bills can be cancelled. For an older bill, issue a credit note (return the items).");
    const [returned] = await tx.select({ n: sql<number>`count(*)::int` }).from(creditNotes).where(eq(creditNotes.invoiceId, invoice.id));
    if ((returned?.n ?? 0) > 0) throw new ConflictError("HAS_CREDIT_NOTES", "Items on this bill were already returned with a credit note, so it can't be cancelled. Return the remaining items instead.");

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


/**
 * Corrects a bill (decision C17 & §2.3: owner, or manager with owner approval/PIN).
 * Cancels the original bill and reissues a new one under a new number in a single transaction,
 * linked by corrects_invoice_id. Reverses stock and payments from the original, applies the new
 * items/totals, and audits the correction.
 */
export async function correctInvoice(session: SessionContext, originalInvoiceId: string, input: unknown): Promise<CreatedInvoice> {
  await requirePermission(session, "invoice.edit");
  const correction = correctInvoiceSchema.parse(input);
  const bill = billInputSchema.parse(input);
  const save = saveBillSchema.parse(input);

  if (!/^[0-9a-f-]{36}$/i.test(originalInvoiceId)) throw new NotFoundError("Bill not found.");

  const requestBody = {
    action: "sales.correct",
    originalInvoiceId,
    reason: correction.reason,
    customerId: bill.customerId ?? null,
    priceList: bill.priceList ?? null,
    placeOfSupply: bill.placeOfSupply ?? null,
    discountPercent: bill.discountPercent,
    payments: bill.payments,
    lines: bill.lines.map((line) => ({
      ...line,
      quantity: line.quantity.toString(),
    })),
    expectedTotalPaise: save.expectedTotalPaise,
  };
  return withTransaction(async (tx) => {
    const outcome = await withIdempotency<Omit<CreatedInvoice, "replayed">>(
      tx,
      {
        shopId: session.shopId,
        userId: session.userId,
        key: save.idempotencyKey,
      },
      requestBody,
      async () => {
        const today = indiaDate();
        await lockDayForWrite(tx, session.shopId, today);

        const [original] = await tx
          .select()
          .from(invoices)
          .where(and(eq(invoices.id, originalInvoiceId), eq(invoices.shopId, session.shopId)))
          .limit(1)
          .for("update");

        if (!original) throw new NotFoundError("Bill not found.");
        if (original.status === "cancelled") throw new ConflictError("ALREADY_CANCELLED", "This bill is already cancelled.");
        if (original.businessDate !== today) throw new ConflictError("NOT_SAME_DAY", "Only today's bills can be corrected. For an older bill, issue a credit note.");

        const [returned] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(creditNotes)
          .where(eq(creditNotes.invoiceId, original.id));
        if ((returned?.n ?? 0) > 0) throw new ConflictError("HAS_CREDIT_NOTES", "Items on this bill were already returned with a credit note, so it cannot be corrected.");

        // A manager needs the owner (handoff §2.3): the owner PIN now, or an approval for this bill number.
        let consumedCorrectionApprovalId: string | null = null;
        if (session.role !== "owner") {
          if (correction.ownerPin) {
            await verifyOwnerPin(session, correction.ownerPin);
          } else {
            const used = correction.approvalId ? await consumeApproval(tx, session, correction.approvalId, "edit_invoice", [original.number]) : await consumeMatchingApproval(tx, session, "edit_invoice", [original.number]);
            if (!used) throw new ConflictError("OWNER_APPROVAL_REQUIRED", `Correcting ${original.number} needs the owner. Enter the owner PIN or ask for approval in Approvals.`);
            consumedCorrectionApprovalId = used.id;
          }
        }

        // Lock order (CLAUDE.md): stock rows of both bills in product order, then both customers' balances.
        const origLines = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, original.id)).orderBy(asc(invoiceLines.lineNo));
        await lockStockRows(tx, session.shopId, [...new Set([...origLines.map((line) => line.productId), ...bill.lines.map((line) => line.productId)])]);
        const origCustomer = await findCustomer(session.shopId, original.customerId, tx);
        const origRegistered = origCustomer.type !== "walkin";
        const chosen = bill.customerId ? await findCustomer(session.shopId, bill.customerId, tx) : null;
        const registered = chosen && chosen.type !== "walkin" ? chosen : null;
        const partyIds = [...new Set([origRegistered ? origCustomer.id : null, registered?.id ?? null].filter((id): id is string => id !== null))].sort();
        for (const partyId of partyIds) await lockPartyBalance(tx, session.shopId, "customer", partyId);

        // 1. Cancel the original invoice

        await tx
          .update(invoices)
          .set({
            status: "cancelled",
            cancelledAt: new Date(),
            cancelledBy: session.userId,
            cancelReason: `Corrected: ${correction.reason}`,
          })
          .where(eq(invoices.id, original.id));

        for (const line of origLines) {
          await appendStockMovement(tx, {
            shopId: session.shopId,
            productId: line.productId,
            movementDate: today,
            kind: "sale_cancel",
            qtyBase: parseQuantity(line.baseQty),
            unitCostPaise: line.unitCostPaise,
            sourceType: "invoice",
            sourceId: original.id,
            reason: `Correction reversal for ${original.number}: ${correction.reason}`,
            createdBy: session.userId,
          });
        }

        if (origRegistered) {
          await appendLedgerEntry(tx, {
            shopId: session.shopId,
            partyType: "customer",
            partyId: origCustomer.id,
            entryDate: today,
            kind: "cancellation",
            sourceType: "invoice",
            sourceId: original.id,
            creditPaise: original.totalPaise,
          });
        }

        const refunds = await refundInvoicePayments(tx, {
          shopId: session.shopId,
          fy: original.fy,
          invoiceId: original.id,
          customerId: origRegistered ? origCustomer.id : null,
          businessDate: today,
          recordedBy: session.userId,
        });

        if (origRegistered) {
          for (const refund of refunds) {
            await appendLedgerEntry(tx, {
              shopId: session.shopId,
              partyType: "customer",
              partyId: origCustomer.id,
              entryDate: today,
              kind: "payment",
              sourceType: "payment",
              sourceId: refund.id,
              debitPaise: refund.amountPaise,
            });
          }
        }

        await recordAudit(tx, actorOf(session), {
          action: "sales.invoice_cancelled",
          entityType: "invoice",
          entityId: original.id,
          approvalId: consumedCorrectionApprovalId,
          before: { status: original.status },
          after: {
            status: "cancelled",
            number: original.number,
            refundedPaise: refunds.reduce((sum, r) => sum + r.amountPaise, 0),
          },
          reason: correction.reason,
        });

        // 2. Issue the new corrected invoice

        const { computed, discountApprovalId: consumedDiscountApprovalId, creditApprovalId: consumedCreditApprovalId } = await computeWithApprovals(tx, session, bill, save, registered?.id ?? null);
        const view = billView(computed);
        const ratesChanged = view.expectedRates.length !== save.expectedRates.length || view.expectedRates.some((rate, index) => rate !== save.expectedRates[index]);
        if (ratesChanged || computed.totals.totalPaise !== save.expectedTotalPaise) {
          throw new ConflictError("PRICE_CHANGED", "Prices changed since this bill was shown. Check the new total and save again.", { bill: view });
        }
        const problem = computed.problems[0];
        if (problem)
          throw new ConflictError(problem.code, problem.message, {
            bill: view,
            problems: computed.problems,
          });

        const customer = chosen ?? (await ensureWalkInCustomer(tx, session.shopId));
        const { fy, number } = await takeDocumentNumber(tx, session.shopId, "INV");
        const newInvoiceId = randomUUID();
        const totals = computed.totals;

        await tx.insert(invoices).values({
          id: newInvoiceId,
          shopId: session.shopId,
          fy,
          number,
          businessDate: today,
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
          taxMode: computed.taxMode,
          placeOfSupply: computed.placeOfSupply,
          discountApprovalId: consumedDiscountApprovalId,
          correctsInvoiceId: original.id,
        });

        await tx.insert(invoiceLines).values(
          computed.lines.map((line, index) => ({
            id: randomUUID(),
            invoiceId: newInvoiceId,
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
            gstRateBp: totals.lines[index]!.gstRateBp,
            cgstPaise: totals.lines[index]!.cgstPaise,
            sgstPaise: totals.lines[index]!.sgstPaise,
            igstPaise: totals.lines[index]!.igstPaise,
            unitCostPaise: line.product.costPaise,
          })),
        );

        for (const line of computed.lines) {
          await appendStockMovement(tx, {
            shopId: session.shopId,
            productId: line.product.id,
            movementDate: today,
            kind: "sale",
            qtyBase: -line.quote.baseQuantity,
            unitCostPaise: line.product.costPaise,
            sourceType: "invoice",
            sourceId: newInvoiceId,
            reason: `${number} (corrects ${original.number})`,
            createdBy: session.userId,
          });
        }

        if (registered) {
          await appendLedgerEntry(tx, {
            shopId: session.shopId,
            partyType: "customer",
            partyId: registered.id,
            entryDate: today,
            kind: "invoice",
            sourceType: "invoice",
            sourceId: newInvoiceId,
            debitPaise: totals.totalPaise,
          });
        }

        for (const method of ["cash", "upi", "card", "bank"] as const) {
          const amount = bill.payments[method];
          if (amount <= 0) continue;
          const paymentId = await recordCounterPayment(tx, {
            shopId: session.shopId,
            fy,
            customerId: registered?.id ?? null,
            invoiceId: newInvoiceId,
            method,
            amountPaise: amount,
            businessDate: today,
            recordedBy: session.userId,
          });
          if (registered) {
            await appendLedgerEntry(tx, {
              shopId: session.shopId,
              partyType: "customer",
              partyId: registered.id,
              entryDate: today,
              kind: "payment",
              sourceType: "payment",
              sourceId: paymentId,
              creditPaise: amount,
            });
          }
        }

        await recordAudit(tx, actorOf(session), {
          action: "sales.invoice_corrected",
          entityType: "invoice",
          entityId: newInvoiceId,
          approvalId: consumedCorrectionApprovalId ?? consumedDiscountApprovalId ?? consumedCreditApprovalId,
          after: {
            number,
            correctsInvoiceId: original.id,
            correctsNumber: original.number,
            totalPaise: totals.totalPaise,
          },
          reason: correction.reason,
        });

        return {
          status: 201,
          body: { id: newInvoiceId, number, totalPaise: totals.totalPaise },
        };
      },
    );
    return { ...outcome.body, replayed: outcome.replayed };
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
  const notes = await db
    .select({ id: creditNotes.id, number: creditNotes.number, totalPaise: creditNotes.totalPaise, settlement: creditNotes.settlement, businessDate: creditNotes.businessDate })
    .from(creditNotes)
    .where(and(eq(creditNotes.invoiceId, invoice.id), eq(creditNotes.shopId, session.shopId)))
    .orderBy(asc(creditNotes.createdAt));
  const canReturn = await hasPermission(session, BILLING_RETURN);
  const [products, customer, payments, users, shop, canCancel] = await Promise.all([
    loadProductNames(session.shopId, lines.map((line) => line.productId)),
    findCustomer(session.shopId, invoice.customerId),
    paymentsForInvoice(db, session.shopId, invoice.id),
    loadUserNames(session.shopId, [invoice.createdBy, ...(invoice.cancelledBy ? [invoice.cancelledBy] : [])]),
    invoiceProfile(session.shopId),
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
    canCancel: canCancel && invoice.status === "issued" && invoice.businessDate === indiaDate() && notes.length === 0,
    canReturn: canReturn && invoice.status === "issued",
    creditNotes: notes,
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
