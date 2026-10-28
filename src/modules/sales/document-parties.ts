import type { Transaction } from "@/server/db";
import { invoiceProfile } from "@/modules/settings";
import type { DocumentBuyer, DocumentSeller } from "./schema";

type Party = { name: string; phone: string | null; gstin: string | null; area?: string | null };

/**
 * Seller and buyer details to freeze on a bill or credit note when it is issued, read inside the
 * same transaction. Later changes to the shop's GSTIN or address, or to the customer, then never
 * alter a document that was already issued.
 */
export async function documentParties(tx: Transaction, shopId: string, customer: Party): Promise<{ seller: DocumentSeller; buyer: DocumentBuyer }> {
  const shop = await invoiceProfile(shopId, tx);
  return {
    seller: { name: shop.name, legalName: shop.legalName, address: shop.address, pinCode: shop.pinCode, phone: shop.phone, email: shop.email, gstin: shop.gstin, stateCode: shop.stateCode, registration: shop.registration },
    buyer: { name: customer.name, phone: customer.phone, gstin: customer.gstin, area: customer.area ?? null },
  };
}

/**
 * What a bill or credit note prints: the frozen seller (identity, address, GSTIN) over the shop's
 * current settings, which still supply the payment details (UPI, bank, terms). Older documents
 * without a snapshot show the current details, as before.
 */
export function printedSeller<T extends Record<string, unknown>>(current: T, frozen: DocumentSeller | null): T & Partial<DocumentSeller> {
  return frozen ? { ...current, ...frozen } : current;
}
