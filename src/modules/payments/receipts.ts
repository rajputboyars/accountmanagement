import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/modules/audit";
import { requirePermission, type SessionContext } from "@/modules/identity";
import { appendLedgerEntry, lockPartyBalance, partyBalance } from "@/modules/ledger";
import { findCustomer } from "@/modules/parties";
import { takeDocumentNumber } from "@/modules/settings";
import { withIdempotency } from "@/modules/sync";
import { lockDayForWrite } from "@/server/day-lock";
import { withTransaction } from "@/server/db";
import { isUniqueViolation } from "@/server/db-errors";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import { financialYearLabel, indiaDate } from "@/shared/financial-year";
import { parseRupeesToPaise } from "@/shared/money";
import { payments } from "./schema";

/**
 * Customer receipts: money received against a customer's dues, not tied to one bill (spec §4).
 * One payment row (with an RCPT/26-27/00001 receipt number) and one ledger credit, in one
 * transaction, idempotent, under the day lock. Which bills it covers is worked out oldest-first
 * from the ledger when shown; nothing is stored per bill. Paying more than the balance is accepted as
 * an advance (handoff C9: a negative balance, used first on the next bill). Cash receipts appear in
 * the cashbook as "old dues paid" from this same row, so nothing is counted twice.
 */

export const PAYMENTS_RECORD = "payments.record" as const;
export const PAYMENTS_REVERSE = "payments.reverse" as const;

const actorOf = (session: SessionContext) => ({ shopId: session.shopId, userId: session.userId, role: session.role });

export const receiptInputSchema = z.object({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, "This form has expired. Reload the page."),
  customerId: z.string().regex(/^[0-9a-f-]{36}$/i, "Choose a customer."),
  amount: z
    .string()
    .trim()
    .transform((value, ctx) => {
      const paise = parseRupeesToPaise(value);
      if (paise === null || paise <= 0) {
        ctx.addIssue({ code: "custom", message: "Enter the amount received, more than 0." });
        return z.NEVER;
      }
      return paise;
    }),
  method: z.enum(["cash", "upi", "bank", "cheque"], { message: "Choose how it was paid." }),
  reference: z
    .string()
    .trim()
    .max(40)
    .optional()
    .transform((value) => value || null),
});

export type RecordedReceipt = { id: string; receiptNumber: string; balanceBeforePaise: number; balanceAfterPaise: number; advancePaise: number; replayed: boolean };

export async function recordCustomerReceipt(session: SessionContext, input: unknown): Promise<RecordedReceipt> {
  await requirePermission(session, PAYMENTS_RECORD);
  const { idempotencyKey, ...data } = receiptInputSchema.parse(input);
  if (data.method === "cheque" && !data.reference) throw new ValidationError("Enter the cheque number.", { fieldErrors: { reference: "Cheque number needed." } });
  try {
    return await withTransaction(async (tx) => {
      const outcome = await withIdempotency<Omit<RecordedReceipt, "replayed">>(tx, { shopId: session.shopId, userId: session.userId, key: idempotencyKey }, { action: "payments.receipt", ...data }, async () => {
        const today = indiaDate();
        await lockDayForWrite(tx, session.shopId, today);
        const customer = await findCustomer(session.shopId, data.customerId, tx);
        if (customer.type === "walkin") throw new ConflictError("WALKIN_NO_ACCOUNT", "The walk-in customer has no account to pay into.");
        await lockPartyBalance(tx, session.shopId, "customer", customer.id);
        const before = await partyBalance(session.shopId, "customer", customer.id, tx);
        const { fy, number } = await takeDocumentNumber(tx, session.shopId, "RCPT");
        const id = randomUUID();
        await tx.insert(payments).values({
          id,
          shopId: session.shopId,
          fy,
          receiptNumber: number,
          direction: "in",
          partyType: "customer",
          partyId: customer.id,
          method: data.method,
          amountPaise: data.amount,
          reference: data.method === "cash" ? null : data.reference,
          businessDate: today,
          recordedBy: session.userId,
        });
        await appendLedgerEntry(tx, { shopId: session.shopId, partyType: "customer", partyId: customer.id, entryDate: today, kind: "payment", sourceType: "payment", sourceId: id, creditPaise: data.amount });
        const after = before - data.amount;
        await recordAudit(tx, actorOf(session), {
          action: "payments.receipt_recorded",
          entityType: "payment",
          entityId: id,
          after: { receiptNumber: number, customerId: customer.id, amountPaise: data.amount, method: data.method, reference: data.reference, balanceBeforePaise: before, balanceAfterPaise: after },
        });
        return { status: 201, body: { id, receiptNumber: number, balanceBeforePaise: before, balanceAfterPaise: after, advancePaise: after < 0 ? -after : 0 } };
      });
      return { ...outcome.body, replayed: outcome.replayed };
    });
  } catch (error) {
    if (isUniqueViolation(error, "payments_no_duplicate_ref")) {
      throw new ConflictError("DUPLICATE_REFERENCE", `A ${data.method.toUpperCase()} payment with reference ${data.reference} is already recorded.`, { fieldErrors: { reference: "Already recorded." } });
    }
    throw error;
  }
}

/**
 * Reverses a receipt entered by mistake (owner, reason): a matching "out" row and a ledger debit,
 * and the original marked reversed. Nothing is deleted. Spec decision 9: a bounced cheque is handled
 * the same way, with no automatic charge.
 */
export async function reverseCustomerReceipt(session: SessionContext, paymentId: string, input: unknown): Promise<void> {
  await requirePermission(session, PAYMENTS_REVERSE);
  const { reason } = z.object({ reason: z.string().trim().min(3, "Write a short reason (at least 3 characters).").max(200) }).parse(input);
  if (!/^[0-9a-f-]{36}$/i.test(paymentId)) throw new NotFoundError("Receipt not found.");
  await withTransaction(async (tx) => {
    const today = indiaDate();
    await lockDayForWrite(tx, session.shopId, today);
    const [original] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.id, paymentId), eq(payments.shopId, session.shopId), eq(payments.partyType, "customer"), eq(payments.direction, "in")))
      .limit(1)
      .for("update");
    if (!original || !original.receiptNumber) throw new NotFoundError("Receipt not found.");
    if (original.status === "reversed") throw new ConflictError("ALREADY_REVERSED", "This receipt is already reversed.");
    await lockPartyBalance(tx, session.shopId, "customer", original.partyId!);
    const reversalId = randomUUID();
    await tx.insert(payments).values({ id: reversalId, shopId: session.shopId, fy: financialYearLabel(), direction: "out", partyType: "customer", partyId: original.partyId, method: original.method, amountPaise: original.amountPaise, businessDate: today, recordedBy: session.userId });
    await tx.update(payments).set({ status: "reversed", reversedByPaymentId: reversalId }).where(eq(payments.id, original.id));
    await appendLedgerEntry(tx, { shopId: session.shopId, partyType: "customer", partyId: original.partyId!, entryDate: today, kind: "payment", sourceType: "payment", sourceId: reversalId, debitPaise: original.amountPaise });
    await recordAudit(tx, actorOf(session), { action: "payments.receipt_reversed", entityType: "payment", entityId: original.id, before: { status: "recorded" }, after: { status: "reversed", reversalId, receiptNumber: original.receiptNumber, amountPaise: original.amountPaise }, reason });
  });
}
