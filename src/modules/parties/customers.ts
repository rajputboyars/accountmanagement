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
import { parseRupeesToPaise } from "@/shared/money";
import { customers } from "./schema";

/**
 * Customer records (spec §4, §8). Balances are never typed in: an opening balance at go-live is one
 * OPENING ledger entry, dated the oldest unpaid bill so ageing is right (spec §8: Gupta ₹62,000 dated
 * 10 Sep). A customer who paid ahead gets a credit (advance). Editing a customer never touches money.
 */

const CUSTOMERS_EDIT = "customers.edit" as const;

const rupees = z
  .string()
  .trim()
  .optional()
  .transform((value, ctx): number => {
    if (!value) return 0;
    const paise = parseRupeesToPaise(value);
    if (paise === null) {
      ctx.addIssue({ code: "custom", message: "Enter an amount in rupees." });
      return z.NEVER;
    }
    return paise;
  });

const customerFields = z.object({
  name: z.string().trim().min(2, "Enter the customer's name.").max(120),
  phone: z
    .string()
    .trim()
    .optional()
    .transform((value) => value?.replace(/[\s-]/g, "") || null)
    .pipe(z.string().regex(/^\d{10}$/, "Phone must be 10 digits.").nullable()),
  type: z.enum(["retail", "wholesale"], { message: "Choose retail or wholesale." }),
  area: z
    .string()
    .trim()
    .max(80)
    .optional()
    .transform((value) => value || null),
  gstin: z
    .string()
    .trim()
    .optional()
    .transform((value) => value?.toUpperCase() || null)
    .pipe(z.string().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "That doesn't look like a GSTIN.").nullable()),
  creditLimit: rupees,
  whatsappConsent: z.union([z.boolean(), z.literal("on"), z.literal("")]).optional().transform((value) => value === true || value === "on"),
});

export const customerCreateSchema = customerFields.extend({
  /** Owed at go-live (positive) or paid in advance (use advance). */
  openingOwed: rupees,
  openingAdvance: rupees,
  oldestBillDate: z
    .string()
    .optional()
    .transform((value) => value || null)
    .pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the date of the oldest unpaid bill.").nullable()),
});

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
        after: { name: data.name, phone: data.phone, type: data.type, creditLimitPaise: data.creditLimit, whatsappConsent: data.whatsappConsent, openingOwedPaise: data.openingOwed, openingAdvancePaise: data.openingAdvance, oldestBillDate: data.oldestBillDate },
      });
      return { id };
    });
  } catch (error) {
    throw phoneConflict(error);
  }
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
        })
        .where(eq(customers.id, customerId));
      await recordAudit(tx, actorOf(session), {
        action: "parties.customer_updated",
        entityType: "customer",
        entityId: customerId,
        before: { name: before.name, phone: before.phone, type: before.type, creditLimitPaise: before.creditLimitPaise, whatsappConsent: before.whatsappConsent },
        after: { name: data.name, phone: data.phone, type: data.type, creditLimitPaise: data.creditLimit, whatsappConsent: data.whatsappConsent },
      });
    });
  } catch (error) {
    throw phoneConflict(error);
  }
}
