import { createPurchaseOrder as createOrder, linkSupplierProducts, receiveGoods as receive } from "@/modules/purchasing";
import type { SessionContext } from "@/modules/identity";

/**
 * Purchases now need each product linked to the supplier. Tests that are about something else (stock,
 * money, reports) use these wrappers, which link first; a refusal to link is ignored so the real call
 * still fails with its own error. The supplier-product check itself is tested in supplier-products.test.ts.
 */
type Input = { supplierId?: string; lines?: { productId?: string }[] };

async function link(session: SessionContext, input: unknown) {
  const { supplierId, lines } = (input ?? {}) as Input;
  if (!supplierId || !Array.isArray(lines)) return;
  const productIds = lines.map((line) => line?.productId).filter((id): id is string => !!id);
  if (productIds.length === 0) return;
  await linkSupplierProducts(session, supplierId, productIds).catch(() => undefined);
}

export async function receiveGoods(session: SessionContext, input: unknown) {
  await link(session, input);
  return receive(session, input);
}

export async function createPurchaseOrder(session: SessionContext, input: unknown) {
  await link(session, input);
  return createOrder(session, input);
}
