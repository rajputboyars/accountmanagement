import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { ZodError, type ZodType } from "zod";
import { recordAudit } from "@/modules/audit";
import { createProduct, exportProducts, listShopProductsForStock, listUnits, productInputSchema } from "@/modules/catalog";
import { hasPermission, loadUserNames, raiseNotification, requirePermission, type SessionContext } from "@/modules/identity";
import { openingLineSchema, recordOpeningStock, stockOnHand } from "@/modules/inventory";
import { createCustomer, customerCreateSchema, listShopCustomers, listShopSuppliers } from "@/modules/parties";
import { createSupplier, supplierInputSchema } from "@/modules/purchasing";
import { listPayables, listReceivables } from "@/modules/reporting";
import { getDb, withTransaction } from "@/server/db";
import { isUniqueViolation } from "@/server/db-errors";
import { ConflictError, isAppError, NotFoundError, ValidationError } from "@/server/errors";
import { csvRupees } from "@/shared/csv";
import { CsvParseError, parseCsv, unescapeFormulaCell } from "@/shared/csv-parse";
import { indiaDate } from "@/shared/financial-year";
import type { Permission } from "@/shared/permissions";
import { parsePercentToBasisPoints } from "@/shared/pricing-engine";
import { IMPORT_TYPES, importJobs, importRows } from "./schema";

/**
 * Data import (spec §8, handoff `import.run`, owner only). A CSV is uploaded, its columns are mapped to
 * the template fields, every row is checked on the server (with the owning module's own Zod schema)
 * and duplicates are flagged, both inside the file and against the shop's records. Nothing is saved
 * until the owner commits; then each row goes through the normal service (createProduct, createCustomer,
 * createSupplier, recordOpeningStock), so stock movements, ledger entries, numbering and audit rows are
 * exactly what the screens would write. A row remembers the record it created, so a retry skips it, and
 * the same file can't be committed twice. Rows are re-checked at commit, since the shop may have changed.
 */

export type ImportType = (typeof IMPORT_TYPES)[number];
export const IMPORT_RUN = "import.run" as const;
export const IMPORT_LIMITS = { maxBytes: 900_000, maxRows: 2_000 } as const;

type Field = { key: string; label: string; required: boolean; example: string; aliases?: string[] };

export const IMPORT_FIELDS: Record<ImportType, Field[]> = {
  products: [
    { key: "name", label: "Product name", required: true, example: "Supreme PVC Elbow 1\"", aliases: ["product", "item", "item name"] },
    { key: "sku", label: "Product code (SKU)", required: true, example: "SP-ELB-1", aliases: ["code", "item code", "product code"] },
    { key: "base_unit", label: "Base unit", required: true, example: "pc", aliases: ["unit", "uom"] },
    { key: "hsn", label: "HSN code", required: true, example: "3917" },
    { key: "gst_rate", label: "GST %", required: true, example: "18", aliases: ["gst", "tax", "gst %"] },
    { key: "retail_price", label: "Retail price (₹)", required: true, example: "35", aliases: ["mrp", "retail", "selling price"] },
    { key: "wholesale_price", label: "Wholesale price (₹)", required: true, example: "30", aliases: ["wholesale"] },
    { key: "cost_price", label: "Cost price (₹)", required: false, example: "22", aliases: ["cost", "purchase price"] },
    { key: "category", label: "Category", required: false, example: "Fittings" },
    { key: "barcode", label: "Barcode", required: false, example: "" },
    { key: "description", label: "Description", required: false, example: "" },
  ],
  customers: [
    { key: "name", label: "Customer name", required: true, example: "Gupta Builders", aliases: ["customer", "party", "party name"] },
    { key: "phone", label: "Phone (10 digits)", required: false, example: "9876543210", aliases: ["mobile", "phone number"] },
    { key: "type", label: "Type (retail/wholesale)", required: false, example: "wholesale" },
    { key: "area", label: "Area", required: false, example: "Malviya Nagar", aliases: ["city", "locality"] },
    { key: "gstin", label: "GSTIN", required: false, example: "" },
    { key: "credit_limit", label: "Credit limit (₹)", required: false, example: "100000", aliases: ["limit"] },
    { key: "whatsapp_consent", label: "WhatsApp consent (yes/no)", required: false, example: "yes", aliases: ["whatsapp"] },
    { key: "opening_owed", label: "Owed at go-live (₹)", required: false, example: "62000", aliases: ["balance", "opening balance", "dues"] },
    { key: "opening_advance", label: "Advance at go-live (₹)", required: false, example: "", aliases: ["advance"] },
    { key: "oldest_bill_date", label: "Oldest unpaid bill date (YYYY-MM-DD)", required: false, example: "2026-09-10" },
  ],
  suppliers: [
    { key: "name", label: "Supplier name", required: true, example: "Supreme Pipes Jaipur", aliases: ["supplier", "party", "party name"] },
    { key: "phone", label: "Phone", required: false, example: "01412345678", aliases: ["mobile"] },
    { key: "gstin", label: "GSTIN", required: false, example: "" },
    { key: "payment_terms_days", label: "Payment terms (days)", required: false, example: "30", aliases: ["terms", "credit days"] },
  ],
  opening_stock: [
    { key: "sku", label: "Product code (SKU)", required: true, example: "SP-ELB-1", aliases: ["code", "item code", "product code"] },
    { key: "quantity", label: "Quantity", required: true, example: "500", aliases: ["qty", "stock", "opening stock"] },
    { key: "unit", label: "Unit (empty = base unit)", required: false, example: "pc", aliases: ["uom"] },
    { key: "unit_cost", label: "Cost per base unit (₹)", required: false, example: "22", aliases: ["cost", "rate"] },
  ],
};

export const IMPORT_TYPE_LABELS: Record<ImportType, string> = { products: "Products", customers: "Customers", suppliers: "Suppliers", opening_stock: "Opening stock" };

/** Besides `import.run`, the person must be allowed to create the records themselves. */
const TYPE_PERMISSION: Record<ImportType, Permission> = { products: "pricing.edit", customers: "customers.edit", suppliers: "purchases.edit", opening_stock: "stock.opening" };

export type ImportMapping = Record<string, number | null>;

const normal = (text: string) => text.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9%]+/g, " ").trim();

/** Header index for each field: by template key, label or a common alias. */
export function autoMap(type: ImportType, headers: string[]): ImportMapping {
  const names = headers.map(normal);
  return Object.fromEntries(
    IMPORT_FIELDS[type].map((field) => {
      const wanted = [field.key.replace(/_/g, " "), normal(field.label), ...(field.aliases ?? []).map(normal)];
      const index = names.findIndex((name) => wanted.includes(name));
      return [field.key, index >= 0 ? index : null];
    }),
  );
}

export function templateCsvRows(type: ImportType): string[][] {
  return [IMPORT_FIELDS[type].map((field) => field.key), IMPORT_FIELDS[type].map((field) => field.example)];
}

// ── Checking rows ────────────────────────────────────────────────────────────

type RowCheck = { result: "new" | "skip" | null; error: string | null; input: Record<string, unknown> | null; key: string | null };

const yes = (value: string) => ["yes", "y", "true", "1", "haan"].includes(value.trim().toLowerCase());

function zodMessage(error: ZodError, labels: Record<string, string>): string {
  return error.issues.map((issue) => `${labels[String(issue.path[0] ?? "")] ?? String(issue.path[0] ?? "Row")}: ${issue.message}`).join("; ");
}

function check(schema: ZodType, input: Record<string, unknown>, labels: Record<string, string>): string | null {
  const parsed = schema.safeParse(input);
  return parsed.success ? null : zodMessage(parsed.error, labels);
}

type ShopState = Awaited<ReturnType<typeof loadShopState>>;

/** What already exists in the shop, for duplicate checks (shop-scoped reads). */
async function loadShopState(session: SessionContext, type: ImportType) {
  if (type === "products") {
    const [items, units] = await Promise.all([listShopProductsForStock(session.shopId, { includeInactive: true }), listUnits(session)]);
    return { skus: new Map(items.map((item) => [item.sku.toUpperCase(), item])), units: new Set(units.filter((unit) => unit.isActive).map((unit) => unit.code)), phones: new Set<string>(), names: new Set<string>(), stocked: new Set<string>() };
  }
  if (type === "customers") {
    const rows = await listShopCustomers(session.shopId, { includeInactive: true });
    return { skus: new Map(), units: new Set<string>(), phones: new Set(rows.flatMap((row) => (row.phone ? [row.phone] : []))), names: new Set(rows.filter((row) => !row.phone).map((row) => row.name.trim().toLowerCase())), stocked: new Set<string>() };
  }
  if (type === "suppliers") {
    const rows = await listShopSuppliers(session.shopId, { includeInactive: true });
    return { skus: new Map(), units: new Set<string>(), phones: new Set<string>(), names: new Set(rows.map((row) => row.name.trim().toLowerCase())), stocked: new Set<string>() };
  }
  const items = await listShopProductsForStock(session.shopId, { includeInactive: false });
  const ledger = await stockOnHand(session.shopId, items.map((item) => item.id));
  return { skus: new Map(items.map((item) => [item.sku.toUpperCase(), item])), units: new Set<string>(), phones: new Set<string>(), names: new Set<string>(), stocked: new Set([...ledger.keys()]) };
}

function checkRow(type: ImportType, value: (key: string) => string, state: ShopState): RowCheck {
  const fail = (error: string): RowCheck => ({ result: null, error, input: null, key: null });
  if (type === "products") {
    const gst = value("gst_rate") ? parsePercentToBasisPoints(value("gst_rate")) : null;
    if (value("gst_rate") && gst === null) return fail("GST %: enter a rate like 18.");
    const input = { name: value("name"), sku: value("sku"), baseUnit: value("base_unit"), hsn: value("hsn"), gstRateBp: gst === null ? "" : String(gst), retailPaise: value("retail_price"), wholesalePaise: value("wholesale_price"), costPaise: value("cost_price"), categoryName: value("category"), barcode: value("barcode"), description: value("description") };
    const error = check(productInputSchema, input, { name: "Product name", sku: "Product code", baseUnit: "Base unit", hsn: "HSN code", gstRateBp: "GST %", retailPaise: "Retail price", wholesalePaise: "Wholesale price", costPaise: "Cost price", categoryName: "Category", barcode: "Barcode", description: "Description" });
    if (error) return fail(error);
    const key = input.sku.trim().toUpperCase();
    if (!state.units.has(input.baseUnit.trim().toLowerCase())) return fail(`Base unit: "${input.baseUnit}" isn't one of this shop's units. Add it in Inventory → Units first.`);
    if (state.skus.has(key)) return { result: "skip", error: `Product code ${key} already exists; left unchanged.`, input, key };
    return { result: "new", error: null, input, key };
  }
  if (type === "customers") {
    const input = { name: value("name"), phone: value("phone"), type: (value("type") || "retail").toLowerCase(), area: value("area"), gstin: value("gstin"), creditLimit: value("credit_limit"), whatsappConsent: yes(value("whatsapp_consent")), openingOwed: value("opening_owed"), openingAdvance: value("opening_advance"), oldestBillDate: value("oldest_bill_date") };
    const error = check(customerCreateSchema, input, { name: "Customer name", phone: "Phone", type: "Type", area: "Area", gstin: "GSTIN", creditLimit: "Credit limit", openingOwed: "Owed at go-live", openingAdvance: "Advance", oldestBillDate: "Oldest bill date" });
    if (error) return fail(error);
    if (input.openingOwed && input.openingAdvance) return fail("Enter either an amount owed or an advance, not both.");
    if (input.oldestBillDate && input.oldestBillDate > indiaDate()) return fail("Oldest bill date can't be in the future.");
    const phone = input.phone.replace(/[\s-]/g, "");
    const key = phone ? `phone:${phone}` : `name:${input.name.trim().toLowerCase()}`;
    if (phone ? state.phones.has(phone) : state.names.has(input.name.trim().toLowerCase())) return { result: "skip", error: phone ? `A customer with phone ${phone} already exists; left unchanged.` : `A customer named ${input.name.trim()} (no phone) already exists; left unchanged.`, input, key };
    return { result: "new", error: null, input, key };
  }
  if (type === "suppliers") {
    const input = { name: value("name"), phone: value("phone"), gstin: value("gstin"), paymentTermsDays: value("payment_terms_days") || "0" };
    const error = check(supplierInputSchema, input, { name: "Supplier name", phone: "Phone", gstin: "GSTIN", paymentTermsDays: "Payment terms" });
    if (error) return fail(error);
    const key = input.name.trim().toLowerCase();
    if (state.names.has(key)) return { result: "skip", error: `A supplier named ${input.name.trim()} already exists; left unchanged.`, input, key };
    return { result: "new", error: null, input, key };
  }
  const sku = value("sku").trim().toUpperCase();
  const product = state.skus.get(sku);
  if (!sku) return fail("Product code: enter the product code.");
  if (!product) return fail(`Product code ${sku} isn't an active product. Import or add the product first.`);
  const input = { productId: product.id, unit: value("unit") || product.baseUnit, quantity: value("quantity"), unitCost: value("unit_cost") };
  const error = check(openingLineSchema, input, { unit: "Unit", quantity: "Quantity", unitCost: "Cost per base unit" });
  if (error) return fail(error);
  if (state.stocked.has(product.id)) return { result: "skip", error: `${product.name} already has stock entries; opening stock is entered once per product.`, input, key: sku };
  return { result: "new", error: null, input, key: sku };
}

type RawRow = { rowNo: number; cells: string[] };

function checkRows(type: ImportType, rows: RawRow[], mapping: ImportMapping, state: ShopState) {
  const missing = IMPORT_FIELDS[type].filter((field) => field.required && (mapping[field.key] === null || mapping[field.key] === undefined));
  const seen = new Map<string, number>();
  return rows.map((row) => {
    if (missing.length) return { rowNo: row.rowNo, result: null, error: `Map the column for: ${missing.map((field) => field.label).join(", ")}.`, input: null };
    const value = (key: string) => {
      const index = mapping[key];
      return index === null || index === undefined ? "" : unescapeFormulaCell((row.cells[index] ?? "").trim());
    };
    const checked = checkRow(type, value, state);
    if (checked.key && checked.result === "new") {
      const first = seen.get(checked.key);
      if (first !== undefined) return { rowNo: row.rowNo, result: "skip" as const, error: `Same as row ${first} in this file; only the first is imported.`, input: checked.input };
      seen.set(checked.key, row.rowNo);
    }
    return { rowNo: row.rowNo, result: checked.result, error: checked.error, input: checked.input };
  });
}

function summarise(rows: { result: string | null; error: string | null }[], created = 0) {
  return { total: rows.length, ready: rows.filter((row) => row.result === "new").length, skipped: rows.filter((row) => row.result === "skip").length, errors: rows.filter((row) => row.result === null).length, created };
}

// ── Upload, map, preview ─────────────────────────────────────────────────────

async function requireImport(session: SessionContext, type: ImportType) {
  await requirePermission(session, IMPORT_RUN);
  await requirePermission(session, TYPE_PERMISSION[type]);
}

function parseType(value: unknown): ImportType {
  if (!(IMPORT_TYPES as readonly unknown[]).includes(value)) throw new ValidationError("Choose what to import.", { fieldErrors: { type: "Choose what to import." } });
  return value as ImportType;
}

export async function previewImport(session: SessionContext, input: { type: unknown; fileName?: string; text: string }) {
  const type = parseType(input.type);
  await requireImport(session, type);
  if (new TextEncoder().encode(input.text).length > IMPORT_LIMITS.maxBytes) throw new ValidationError("The file is larger than 900 KB. Split it into smaller files.");
  let table: string[][];
  try {
    table = parseCsv(input.text);
  } catch (error) {
    if (error instanceof CsvParseError) throw new ValidationError(`This isn't a readable CSV file. ${error.message}`);
    throw error;
  }
  const [headers, ...body] = table;
  if (!headers || body.length === 0) throw new ValidationError("The file has no rows under the header row.");
  if (body.length > IMPORT_LIMITS.maxRows) throw new ValidationError(`The file has ${body.length} rows; import at most ${IMPORT_LIMITS.maxRows} at a time.`);
  const fileKey = createHash("sha256").update(input.text).digest("hex");
  const [done] = await getDb()
    .select({ id: importJobs.id })
    .from(importJobs)
    .where(and(eq(importJobs.shopId, session.shopId), eq(importJobs.type, type), eq(importJobs.fileKey, fileKey), eq(importJobs.status, "committed")))
    .limit(1);
  if (done) throw new ConflictError("ALREADY_IMPORTED", "This exact file was already imported. Nothing was changed.", { jobId: done.id });

  const mapping = autoMap(type, headers);
  const raw = body.map((cells, index) => ({ rowNo: index + 2, cells }));
  const checked = checkRows(type, raw, mapping, await loadShopState(session, type));
  const fileName = (input.fileName ?? "").replace(/[^\w .()-]/g, "").slice(0, 120) || null;
  const jobId = randomUUID();
  await withTransaction(async (tx) => {
    await tx.insert(importJobs).values({ id: jobId, shopId: session.shopId, type, fileKey, fileName, mapping, status: "previewed", summary: { headers, ...summarise(checked) }, createdBy: session.userId });
    for (let start = 0; start < raw.length; start += 500) {
      await tx.insert(importRows).values(raw.slice(start, start + 500).map((row, offset) => ({ importJobId: jobId, rowNo: row.rowNo, data: { cells: row.cells }, result: checked[start + offset]!.result, error: checked[start + offset]!.error })));
    }
    await recordAudit(tx, { shopId: session.shopId, userId: session.userId, role: session.role }, { action: "imports.previewed", entityType: "import_job", entityId: jobId, after: { type, fileName, rows: raw.length } });
  });
  return getImport(session, jobId);
}

async function loadJob(session: SessionContext, jobId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new NotFoundError("Import not found.");
  const [job] = await getDb().select().from(importJobs).where(and(eq(importJobs.id, jobId), eq(importJobs.shopId, session.shopId))).limit(1);
  if (!job) throw new NotFoundError("Import not found.");
  return job;
}

const rawRows = async (jobId: string) => (await getDb().select({ id: importRows.id, rowNo: importRows.rowNo, data: importRows.data, entityId: importRows.entityId }).from(importRows).where(eq(importRows.importJobId, jobId)).orderBy(asc(importRows.rowNo))).map((row) => ({ ...row, cells: (row.data as { cells: string[] }).cells }));

/** Change which column feeds which field, and check the rows again. */
export async function remapImport(session: SessionContext, jobId: string, mappingInput: Record<string, unknown>) {
  const job = await loadJob(session, jobId);
  await requireImport(session, job.type);
  if (job.status !== "previewed") throw new ConflictError("IMPORT_NOT_EDITABLE", "This import was already committed.");
  const headers = ((job.summary as { headers?: string[] } | null)?.headers ?? []) as string[];
  const mapping: ImportMapping = Object.fromEntries(
    IMPORT_FIELDS[job.type].map((field) => {
      const value = mappingInput[field.key];
      const index = value === "" || value === null || value === undefined ? null : Number(value);
      return [field.key, index !== null && Number.isInteger(index) && index >= 0 && index < headers.length ? index : null];
    }),
  );
  const rows = await rawRows(job.id);
  const checked = checkRows(job.type, rows, mapping, await loadShopState(session, job.type));
  await withTransaction(async (tx) => {
    for (const [index, row] of rows.entries()) await tx.update(importRows).set({ result: checked[index]!.result, error: checked[index]!.error }).where(eq(importRows.id, row.id));
    await tx.update(importJobs).set({ mapping, summary: { headers, ...summarise(checked) } }).where(and(eq(importJobs.id, job.id), eq(importJobs.status, "previewed")));
  });
  return getImport(session, job.id);
}

// ── Commit ───────────────────────────────────────────────────────────────────

function rowError(error: unknown): { duplicate: boolean; message: string } {
  if (error instanceof ZodError) return { duplicate: false, message: error.issues.map((issue) => issue.message).join("; ") };
  if (isAppError(error)) return { duplicate: ["PHONE_IN_USE", "SKU_IN_USE", "SUPPLIER_EXISTS", "DUPLICATE", "OPENING_EXISTS"].includes(error.code) || /already/i.test(error.message), message: error.message };
  if (isUniqueViolation(error)) return { duplicate: true, message: "Already exists." };
  throw error;
}

/**
 * Saves the ready rows through the normal services. Only one import of a kind runs at a time per shop
 * (claimed under an advisory lock); a row that already created its record is skipped, so running
 * commit again after a failure finishes the job without duplicates. Committing a committed job is a no-op.
 */
export async function commitImport(session: SessionContext, jobId: string) {
  const job = await loadJob(session, jobId);
  await requireImport(session, job.type);
  if (job.status === "committed") return { ...(await getImport(session, job.id)), replayed: true };

  await withTransaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`import:${session.shopId}:${job.type}`}))`);
    const [busy] = await tx
      .select({ id: importJobs.id })
      .from(importJobs)
      .where(and(eq(importJobs.shopId, session.shopId), eq(importJobs.type, job.type), eq(importJobs.status, "committing"), sql`${importJobs.id} <> ${job.id}`, sql`coalesce((${importJobs.summary}->>'claimedAt')::timestamptz, now()) > now() - interval '15 minutes'`))
      .limit(1);
    if (busy) throw new ConflictError("IMPORT_RUNNING", "Another import of this kind is being saved. Try again in a minute.");
    const [claimed] = await tx
      .update(importJobs)
      .set({ status: "committing", summary: sql`coalesce(${importJobs.summary}, '{}'::jsonb) || jsonb_build_object('claimedAt', now())` })
      // A job left "committing" by a crash can be resumed after 15 minutes; a live one can't be claimed twice.
      .where(and(eq(importJobs.id, job.id), sql`(${inArray(importJobs.status, ["previewed", "failed"])} or (${importJobs.status} = 'committing' and coalesce((${importJobs.summary}->>'claimedAt')::timestamptz, now()) <= now() - interval '15 minutes'))`))
      .returning({ id: importJobs.id });
    if (!claimed) throw new ConflictError("IMPORT_RUNNING", "This import is already being saved. Refresh in a moment.");
  });

  const rows = await rawRows(job.id);
  const mapping = (job.mapping ?? {}) as ImportMapping;
  const checked = checkRows(job.type, rows.map((row) => ({ rowNo: row.rowNo, cells: row.cells })), mapping, await loadShopState(session, job.type));
  const db = getDb();
  const setRow = (id: string, values: { result: "new" | "skip" | null; error: string | null; entityId?: string }) => db.update(importRows).set(values).where(eq(importRows.id, id));

  const pending: { row: (typeof rows)[number]; input: Record<string, unknown> }[] = [];
  for (const [index, row] of rows.entries()) {
    const result = checked[index]!;
    if (row.entityId) continue; // created by an earlier attempt
    if (result.result !== "new" || !result.input) await setRow(row.id, { result: result.result, error: result.error });
    else pending.push({ row, input: result.input });
  }

  if (job.type === "opening_stock") {
    for (let start = 0; start < pending.length; start += 200) {
      const chunk = pending.slice(start, start + 200);
      try {
        await recordOpeningStock(session, { idempotencyKey: `import_${job.id.replace(/-/g, "")}_${start}`, movementDate: indiaDate(), note: `Imported from ${job.fileName ?? "CSV"}`, lines: chunk.map((item) => item.input) });
        for (const item of chunk) await setRow(item.row.id, { result: "new", error: null, entityId: String(item.input.productId) });
      } catch (error) {
        const { message } = rowError(error);
        for (const item of chunk) await setRow(item.row.id, { result: null, error: `Not saved with rows ${chunk[0]!.row.rowNo}–${chunk.at(-1)!.row.rowNo}: ${message}` });
      }
    }
  } else {
    const create = job.type === "products" ? createProduct : job.type === "customers" ? createCustomer : createSupplier;
    for (const item of pending) {
      try {
        const { id } = await create(session, item.input);
        await setRow(item.row.id, { result: "new", error: null, entityId: id });
      } catch (error) {
        const { duplicate, message } = rowError(error);
        await setRow(item.row.id, { result: duplicate ? "skip" : null, error: message });
      }
    }
  }

  const final = await db.select({ result: importRows.result, error: importRows.error, entityId: importRows.entityId }).from(importRows).where(eq(importRows.importJobId, job.id));
  const summary = { headers: (job.summary as { headers?: string[] } | null)?.headers ?? [], ...summarise(final, final.filter((row) => row.entityId).length) };
  try {
    await withTransaction(async (tx) => {
      await tx.update(importJobs).set({ status: "committed", summary }).where(eq(importJobs.id, job.id));
      await recordAudit(tx, { shopId: session.shopId, userId: session.userId, role: session.role }, { action: "imports.committed", entityType: "import_job", entityId: job.id, after: { type: job.type, fileName: job.fileName, ...summary, headers: undefined } });
      // Tell the person who ran it how it went, once per import (the dedupe key is the job).
      await raiseNotification(
        {
          shopId: session.shopId,
          kind: "import_finished",
          title: `${IMPORT_TYPE_LABELS[job.type]} import finished`,
          body: `${summary.created} saved · ${summary.skipped} skipped · ${summary.errors} with errors${summary.errors + summary.skipped > 0 ? ". Download the rows left out to fix them." : "."}`,
          href: `/settings/setup/imports/${job.id}`,
          dedupeKey: `import:${job.id}`,
          to: { userIds: [session.userId] },
        },
        tx,
      );
    });
  } catch (error) {
    if (!isUniqueViolation(error, "import_jobs_committed_file_key")) throw error;
    await db.update(importJobs).set({ status: "failed", summary: { ...summary, note: "The same file was already imported by another job." } }).where(eq(importJobs.id, job.id));
  }
  return { ...(await getImport(session, job.id)), replayed: false };
}

// ── Reading ──────────────────────────────────────────────────────────────────

export async function getImport(session: SessionContext, jobId: string) {
  await requirePermission(session, IMPORT_RUN);
  const job = await loadJob(session, jobId);
  const rows = await getDb()
    .select({ rowNo: importRows.rowNo, data: importRows.data, result: importRows.result, error: importRows.error, entityId: importRows.entityId })
    .from(importRows)
    .where(eq(importRows.importJobId, job.id))
    .orderBy(asc(importRows.rowNo))
    .limit(500);
  const summary = (job.summary ?? {}) as { headers?: string[]; total?: number; ready?: number; skipped?: number; errors?: number; created?: number; note?: string };
  return {
    id: job.id,
    type: job.type,
    typeLabel: IMPORT_TYPE_LABELS[job.type],
    fileName: job.fileName,
    status: job.status,
    createdAt: job.createdAt,
    headers: summary.headers ?? [],
    mapping: (job.mapping ?? {}) as ImportMapping,
    fields: IMPORT_FIELDS[job.type],
    summary: { total: summary.total ?? 0, ready: summary.ready ?? 0, skipped: summary.skipped ?? 0, errors: summary.errors ?? 0, created: summary.created ?? 0, note: summary.note ?? null },
    rows: rows.map((row) => ({ rowNo: row.rowNo, cells: (row.data as { cells: string[] }).cells, result: row.result, error: row.error, saved: row.entityId !== null })),
  };
}

export type ImportView = Awaited<ReturnType<typeof getImport>>;

/** Import history, newest first. */
export async function listImports(session: SessionContext, limit = 30) {
  await requirePermission(session, IMPORT_RUN);
  const jobs = await getDb().select().from(importJobs).where(eq(importJobs.shopId, session.shopId)).orderBy(desc(importJobs.createdAt)).limit(limit);
  const names = await loadUserNames(session.shopId, [...new Set(jobs.map((job) => job.createdBy))]);
  return jobs.map((job) => {
    const summary = (job.summary ?? {}) as { total?: number; created?: number; skipped?: number; errors?: number };
    return { id: job.id, type: job.type, typeLabel: IMPORT_TYPE_LABELS[job.type], fileName: job.fileName, status: job.status, createdAt: job.createdAt, createdByName: names.get(job.createdBy) ?? "Unknown", total: summary.total ?? 0, created: summary.created ?? 0, skipped: summary.skipped ?? 0, errors: summary.errors ?? 0 };
  });
}

/** Rows that weren't imported (errors and skips) with the reason, for fixing and re-uploading. */
export async function importProblemRows(session: SessionContext, jobId: string) {
  await requirePermission(session, IMPORT_RUN);
  const job = await loadJob(session, jobId);
  const rows = await getDb()
    .select({ rowNo: importRows.rowNo, data: importRows.data, result: importRows.result, error: importRows.error })
    .from(importRows)
    .where(and(eq(importRows.importJobId, job.id), sql`${importRows.error} is not null`))
    .orderBy(asc(importRows.rowNo));
  const headers = ((job.summary as { headers?: string[] } | null)?.headers ?? []) as string[];
  return { job, headers, rows: rows.map((row) => ({ rowNo: row.rowNo, cells: (row.data as { cells: string[] }).cells, problem: row.result === "skip" ? `Skipped: ${row.error}` : `Error: ${row.error}` })) };
}

/** Records created by imports so far, per type (for the onboarding checklist). */
export async function importedCounts(session: SessionContext) {
  const rows = await getDb()
    .select({ type: importJobs.type, count: sql<number>`count(*)::int` })
    .from(importRows)
    .innerJoin(importJobs, eq(importJobs.id, importRows.importJobId))
    .where(and(eq(importJobs.shopId, session.shopId), isNotNull(importRows.entityId)))
    .groupBy(importJobs.type);
  return Object.fromEntries(rows.map((row) => [row.type, row.count])) as Partial<Record<ImportType, number>>;
}

export async function canImport(session: SessionContext) {
  return hasPermission(session, IMPORT_RUN);
}

// ── Exports ──────────────────────────────────────────────────────────────────

export const EXPORT_TYPES = ["products", "customers", "suppliers"] as const;
export type ExportType = (typeof EXPORT_TYPES)[number];

/**
 * The shop's records as CSV rows in import-template column order (plus balances), so an export can be
 * edited and imported into another shop. Each export needs the permission that shows that data; cost
 * prices only with `profit.view`. Cells are made formula-safe by `toCsv`.
 */
export async function exportRows(session: SessionContext, type: string): Promise<{ type: ExportType; rows: (string | number)[][] }> {
  const rupees = (paise: number | null) => (paise === null ? "" : csvRupees(paise));
  if (type === "products") {
    const { costVisible, rows } = await exportProducts(session);
    return {
      type,
      rows: [
        ["name", "sku", "base_unit", "hsn", "gst_rate", "retail_price", "wholesale_price", ...(costVisible ? ["cost_price"] : []), "category", "barcode", "description", "active"],
        ...rows.map((row) => [row.name, row.sku, row.baseUnit, row.hsn, String(row.gstRateBp / 100), rupees(row.retailPaise), rupees(row.wholesalePaise), ...(costVisible ? [rupees(row.costPaise)] : []), row.categoryName ?? "", row.barcode ?? "", row.description ?? "", row.isActive ? "yes" : "no"]),
      ],
    };
  }
  if (type === "customers") {
    const { rows } = await listReceivables(session);
    return {
      type,
      rows: [
        ["name", "phone", "type", "area", "gstin", "credit_limit", "whatsapp_consent", "balance", "overdue"],
        ...rows.filter((row) => row.type !== "walkin").map((row) => [row.name, row.phone ?? "", row.type, row.area ?? "", row.gstin ?? "", rupees(row.creditLimitPaise), row.whatsappConsent ? "yes" : "no", rupees(row.balancePaise), rupees(row.overduePaise)]),
      ],
    };
  }
  if (type === "suppliers") {
    await requirePermission(session, "purchases.view");
    const [suppliers, payables] = await Promise.all([listShopSuppliers(session.shopId, { includeInactive: true }), listPayables(session)]);
    const owed = new Map(payables.rows.map((row) => [row.id, row.owedPaise]));
    return { type, rows: [["name", "phone", "gstin", "payment_terms_days", "you_owe"], ...suppliers.map((row) => [row.name, row.phone ?? "", row.gstin ?? "", String(row.paymentTermsDays), rupees(owed.get(row.id) ?? 0)])] };
  }
  throw new NotFoundError("There is no such export.");
}
