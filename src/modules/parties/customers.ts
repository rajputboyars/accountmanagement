import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/modules/audit";
import { requirePermission, type SessionContext } from "@/modules/identity";
import { appendLedgerEntry, lockPartyBalance } from "@/modules/ledger";
import { withTransaction } from "@/server/db";
import { isUniqueViolation } from "@/server/db-errors";
import { ConflictError, NotFoundError } from "@/server/errors";
import { indiaDate } from "@/shared/financial-year";
import { LANGUAGES, type Language } from "@/shared/i18n/languages";
import { customers } from "./schema";
import { customerCreateSchema, customerFields } from "./validation";

export { customerCreateSchema };

/**
 * Customer records (spec §4, §8). Balances are never typed in: an opening balance at go-live is one
 * OPENING ledger entry, dated the oldest unpaid bill so ageing is right (spec §8: Gupta ₹62,000 dated
 * 10 Sep). A customer who paid ahead gets a credit (advance). Editing a customer never touches money.
 */

const CUSTOMERS_EDIT = "customers.edit" as const;

const actorOf = (session: SessionContext) => ({ shopId: session.shopId, userId: session.userId, role: session.role });

function phoneConflict(error: unknown) {
  if (isUniqueViolation(error, "customers_shop_phone_key")) return new ConflictError("PHONE_IN_USE", "Another customer already has this phone number.", { fieldErrors: { phone: "Already used by another customer." } });
  return error;
}

export async function createCustomer(session: SessionContext, input: unknown): Promise<{ id: string }> {
  await requirePermission(session, CUSTOMERS_EDIT);
  const data = customerCreateSchema.parse(input);
  if (data.openingOwed && data.openingAdvance) throw new ConflictError("OPENING_BOTH", "Enter either an amount owed or an advance, not both.");
  try {
    return await withTransaction(async (tx) => {
      const id = randomUUID();
      await tx.insert(customers).values({
        id,
        shopId: session.shopId,
        name: data.name,
        phone: data.phone,
        type: data.type,
        area: data.area,
        gstin: data.gstin,
        creditLimitPaise: data.creditLimit,
        whatsappConsent: data.whatsappConsent,
        consentUpdatedAt: data.whatsappConsent ? new Date() : null,
        communicationLanguage: data.communicationLanguage ?? null,
      });
      const opening = data.openingOwed || data.openingAdvance;
      if (opening) {
        await lockPartyBalance(tx, session.shopId, "customer", id);
        await appendLedgerEntry(tx, {
          shopId: session.shopId,
          partyType: "customer",
          partyId: id,
          entryDate: data.oldestBillDate ?? indiaDate(),
          kind: "opening",
          sourceType: "opening_balance",
          sourceId: randomUUID(),
          ...(data.openingOwed ? { debitPaise: data.openingOwed } : { creditPaise: data.openingAdvance }),
        });
      }
      await recordAudit(tx, actorOf(session), {
        action: "parties.customer_added",
        entityType: "customer",
        entityId: id,
        after: { name: data.name, phone: data.phone, type: data.type, creditLimitPaise: data.creditLimit, whatsappConsent: data.whatsappConsent, communicationLanguage: data.communicationLanguage ?? null, openingOwedPaise: data.openingOwed, openingAdvancePaise: data.openingAdvance, oldestBillDate: data.oldestBillDate },
      });
      return { id };
    });
  } catch (error) {
    throw phoneConflict(error);
  }
}

/** Saves only the message language, for the bill-sharing screen. Same permission as editing the customer; audited. */
export async function setCustomerCommunicationLanguage(session: SessionContext, customerId: string, input: unknown): Promise<Language> {
  await requirePermission(session, CUSTOMERS_EDIT);
  const language = z.enum(LANGUAGES, { message: "Choose a message language." }).parse(input);
  if (!/^[0-9a-f-]{36}$/i.test(customerId)) throw new NotFoundError("Customer not found.");
  await withTransaction(async (tx) => {
    const [before] = await tx.select().from(customers).where(and(eq(customers.id, customerId), eq(customers.shopId, session.shopId))).limit(1).for("update");
    if (!before || before.type === "walkin") throw new NotFoundError("Customer not found.");
    await tx.update(customers).set({ communicationLanguage: language }).where(eq(customers.id, customerId));
    await recordAudit(tx, actorOf(session), { action: "parties.customer_language_set", entityType: "customer", entityId: customerId, before: { communicationLanguage: before.communicationLanguage }, after: { communicationLanguage: language } });
  });
  return language;
}

export async function updateCustomer(session: SessionContext, customerId: string, input: unknown): Promise<void> {
  await requirePermission(session, CUSTOMERS_EDIT);
  const data = customerFields.parse(input);
  if (!/^[0-9a-f-]{36}$/i.test(customerId)) throw new NotFoundError("Customer not found.");
  try {
    await withTransaction(async (tx) => {
      const [before] = await tx.select().from(customers).where(and(eq(customers.id, customerId), eq(customers.shopId, session.shopId))).limit(1).for("update");
      if (!before || before.type === "walkin") throw new NotFoundError("Customer not found.");
      await tx
        .update(customers)
        .set({
          name: data.name,
          phone: data.phone,
          type: data.type,
          area: data.area,
          gstin: data.gstin,
          creditLimitPaise: data.creditLimit,
          whatsappConsent: data.whatsappConsent,
          consentUpdatedAt: data.whatsappConsent !== before.whatsappConsent ? new Date() : before.consentUpdatedAt,
          communicationLanguage: data.communicationLanguage === undefined ? before.communicationLanguage : data.communicationLanguage,
        })
        .where(eq(customers.id, customerId));
      await recordAudit(tx, actorOf(session), {
        action: "parties.customer_updated",
        entityType: "customer",
        entityId: customerId,
        before: { name: before.name, phone: before.phone, type: before.type, creditLimitPaise: before.creditLimitPaise, whatsappConsent: before.whatsappConsent, communicationLanguage: before.communicationLanguage },
        after: { name: data.name, phone: data.phone, type: data.type, creditLimitPaise: data.creditLimit, whatsappConsent: data.whatsappConsent, communicationLanguage: data.communicationLanguage === undefined ? before.communicationLanguage : data.communicationLanguage },
      });
    });
  } catch (error) {
    throw phoneConflict(error);
  }
}
