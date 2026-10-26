"use server";

import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import {
  addProductUnit,
  createProduct,
  createUnit,
  setProductActive,
  setProductUnitActive,
  setUnitActive,
  updateProduct,
  updateProductUnitFactor,
} from "@/modules/catalog";
import { toActionError } from "@/server/action-result";
import { requireSession } from "@/server/auth";

/**
 * Catalog server actions. Each one re-reads the session on the server; the catalog services check
 * permissions and scope every query to the session's shop. Nothing from the form decides identity.
 */

export type CatalogFormState = {
  ok?: boolean;
  error?: string;
  message?: string;
  fieldErrors?: Record<string, string>;
  values?: Record<string, string>;
  nonce?: number;
};

const text = (formData: FormData, name: string) => String(formData.get(name) ?? "");

const PRODUCT_FIELDS = ["name", "sku", "barcode", "categoryName", "description", "baseUnit", "hsn", "gstRateBp", "retailPrice", "wholesalePrice", "costPrice"] as const;

function productInput(formData: FormData) {
  const values = Object.fromEntries(PRODUCT_FIELDS.map((field) => [field, text(formData, field)]));
  return {
    values,
    input: {
      name: values.name,
      sku: values.sku,
      barcode: values.barcode,
      categoryName: values.categoryName,
      description: values.description,
      baseUnit: values.baseUnit,
      hsn: values.hsn,
      gstRateBp: values.gstRateBp,
      retailPaise: values.retailPrice,
      wholesalePaise: values.wholesalePrice,
      costPaise: values.costPrice,
    },
  };
}

/** Service field names → form field names, so errors land next to the right input. */
const FIELD_ALIASES: Record<string, string> = { retailPaise: "retailPrice", wholesalePaise: "wholesalePrice", costPaise: "costPrice" };

/** Conflicts that belong to one form field, so the message shows next to that input. */
const CONFLICT_FIELDS: Record<string, string> = {
  SKU_IN_USE: "sku",
  BARCODE_IN_USE: "barcode",
  UNIT_NAME_IN_USE: "name",
  UNIT_CODE_IN_USE: "code",
  PACKAGING_EXISTS: "unit",
  UNIT_INACTIVE: "unit",
};

function failure(error: unknown, values?: Record<string, string>): CatalogFormState {
  const result = toActionError(error);
  const conflictField = result.code ? CONFLICT_FIELDS[result.code] : undefined;
  const fieldErrors = result.fieldErrors
    ? Object.fromEntries(Object.entries(result.fieldErrors).map(([key, message]) => [FIELD_ALIASES[key] ?? key, message]))
    : conflictField && values && conflictField in values
      ? { [conflictField]: result.error }
      : undefined;
  return { ok: false, error: result.error, fieldErrors, values };
}

export async function createProductAction(_previous: CatalogFormState, formData: FormData): Promise<CatalogFormState> {
  const { values, input } = productInput(formData);
  let productId: string;
  try {
    const session = await requireSession();
    ({ id: productId } = await createProduct(session, input));
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, values);
  }
  revalidatePath("/inventory");
  redirect(`/inventory/${productId}?saved=1`);
}

export async function updateProductAction(_previous: CatalogFormState, formData: FormData): Promise<CatalogFormState> {
  const { values, input } = productInput(formData);
  const productId = text(formData, "productId");
  try {
    const session = await requireSession();
    await updateProduct(session, productId, { ...input, version: text(formData, "version") });
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, values);
  }
  revalidatePath("/inventory");
  revalidatePath(`/inventory/${productId}`);
  return { ok: true, message: "Changes saved.", nonce: Date.now() };
}

export async function setProductActiveAction(_previous: CatalogFormState, formData: FormData): Promise<CatalogFormState> {
  const productId = text(formData, "productId");
  const active = text(formData, "active") === "true";
  try {
    const session = await requireSession();
    await setProductActive(session, productId, active);
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
  revalidatePath("/inventory");
  revalidatePath(`/inventory/${productId}`);
  return { ok: true, message: active ? "Product switched on." : "Product switched off. It no longer shows in the active list.", nonce: Date.now() };
}

export async function addProductUnitAction(_previous: CatalogFormState, formData: FormData): Promise<CatalogFormState> {
  const productId = text(formData, "productId");
  const values = { unit: text(formData, "unit"), factor: text(formData, "factor") };
  try {
    const session = await requireSession();
    await addProductUnit(session, productId, values);
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, values);
  }
  revalidatePath(`/inventory/${productId}`);
  revalidatePath("/inventory");
  return { ok: true, message: "Pack size saved.", nonce: Date.now() };
}

export async function updateProductUnitAction(_previous: CatalogFormState, formData: FormData): Promise<CatalogFormState> {
  const productId = text(formData, "productId");
  try {
    const session = await requireSession();
    await updateProductUnitFactor(session, productId, text(formData, "packagingId"), text(formData, "factor"));
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, { factor: text(formData, "factor") });
  }
  revalidatePath(`/inventory/${productId}`);
  revalidatePath("/inventory");
  return { ok: true, message: "Size updated.", nonce: Date.now() };
}

export async function setProductUnitActiveAction(_previous: CatalogFormState, formData: FormData): Promise<CatalogFormState> {
  const productId = text(formData, "productId");
  try {
    const session = await requireSession();
    await setProductUnitActive(session, productId, text(formData, "packagingId"), text(formData, "active") === "true");
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
  revalidatePath(`/inventory/${productId}`);
  revalidatePath("/inventory");
  return { ok: true, nonce: Date.now() };
}

export async function createUnitAction(_previous: CatalogFormState, formData: FormData): Promise<CatalogFormState> {
  const values = { name: text(formData, "name"), code: text(formData, "code"), allowDecimal: formData.get("allowDecimal") === "on" ? "on" : "" };
  try {
    const session = await requireSession();
    await createUnit(session, { name: values.name, code: values.code, allowDecimal: values.allowDecimal === "on" });
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, values);
  }
  revalidatePath("/inventory/units");
  return { ok: true, message: `${values.name} added.`, nonce: Date.now() };
}

export async function setUnitActiveAction(_previous: CatalogFormState, formData: FormData): Promise<CatalogFormState> {
  try {
    const session = await requireSession();
    await setUnitActive(session, text(formData, "code"), text(formData, "active") === "true");
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
  revalidatePath("/inventory/units");
  return { ok: true, nonce: Date.now() };
}
