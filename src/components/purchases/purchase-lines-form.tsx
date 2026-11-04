"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { LoaderCircle, Plus, Trash2 } from "lucide-react";
import { createOrderAction, linkSupplierProductsAction, receiveGoodsAction } from "@/app/(app)/purchases/actions";
import { Field, FormAlert, selectClass } from "@/components/catalog/form-bits";
import { useT } from "@/components/nexora/language-provider";
import { Money } from "@/components/nexora/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LinkProductPanel, QuickProductPanel, QuickSupplierPanel, type ProductQuickCreate, type QuickProduct } from "./purchase-quick-create";
import { parseRupeesToPaise } from "@/shared/money";
import { computePurchaseTotals } from "@/shared/purchase";
import { parseQuantity } from "@/shared/quantity";
import { STATUTORY_GST_RATES_BP } from "@/shared/gst";

export type PurchasableProduct = { id: string; name: string; sku: string; baseUnit: string; gstRateBp: number; units: { code: string; label: string }[] };
export type OrderLineForReceipt = { id: string; productName: string; unit: string; baseUnit: string; leftBase: string; leftInUnit: string | null; costPaisePerUnit: number; gstRateBp: number; unitLabel: string; baseUnitLabel: string };

const ADD_SUPPLIER = "__add_supplier__";
const ADD_PRODUCT = "__add_product__";
const LINK_PRODUCT = "__link_product__";
type Panel = { type: "supplier" } | { type: "product"; lineKey: number } | { type: "link"; lineKey: number };

type Line = { key: number; productId: string; purchaseOrderLineId: string; unit: string; quantity: string; cost: string; gstRateBp: string; label?: string };

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "") : `${Date.now()}${Math.random().toString(36).slice(2)}`);
const GST: readonly number[] = STATUTORY_GST_RATES_BP;
const rupeeText = (paise: number) => (paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2));

/** Live total from the shared purchase maths; the server works it out again when saving. */
function previewTotal(lines: Line[]) {
  try {
    const parsed = lines.map((line) => {
      const cost = parseRupeesToPaise(line.cost);
      if (cost === null) throw new Error("cost");
      return { quantity: parseQuantity(line.quantity), costPaisePerUnit: cost, gstRateBp: Number(line.gstRateBp) };
    });
    return parsed.length ? computePurchaseTotals(parsed) : null;
  } catch {
    return null;
  }
}

/**
 * One editor for a new purchase order, a direct goods receipt (no order) and receiving against an
 * order. Orders have no GST or bill number; receipts capture the supplier's bill.
 */
export function PurchaseLinesForm({
  mode,
  suppliers,
  products,
  order,
  defaultSupplierId = "",
  links = {},
  quick,
  godowns,
}: {
  mode: "order" | "receipt";
  defaultSupplierId?: string;
  suppliers: { id: string; name: string }[];
  products: PurchasableProduct[];
  order?: { id: string; supplierName: string; lines: OrderLineForReceipt[] };
  /** Supplier id → ids of the products that supplier supplies. */
  links?: Record<string, string[]>;
  /** Where goods can be received, only when the shop has more than one godown; the Main Store is the default. */
  godowns?: { id: string; name: string; isDefault: boolean }[];
  /** What the signed-in person may quick-add; omitted when nothing is offered. */
  quick?: { canAddSupplier: boolean; canLinkProducts: boolean; productCreate: ProductQuickCreate | null };
}) {
  const t = useT();
  const router = useRouter();
  const [supplierId, setSupplierId] = useState(defaultSupplierId);
  const [billNo, setBillNo] = useState("");
  const [billDate, setBillDate] = useState("");
  const [lines, setLines] = useState<Line[]>(() =>
    order
      ? order.lines.map((line, index) => ({ key: index + 1, productId: "", purchaseOrderLineId: line.id, unit: line.unit, quantity: line.leftInUnit ?? "", cost: rupeeText(line.costPaisePerUnit), gstRateBp: String(line.gstRateBp), label: line.productName }))
      : [{ key: 1, productId: "", purchaseOrderLineId: "", unit: "", quantity: "", cost: "", gstRateBp: "0" }],
  );
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [idempotencyKey] = useState(newKey);
  const [pending, startTransition] = useTransition();
  const [extraSuppliers, setExtraSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [extraProducts, setExtraProducts] = useState<PurchasableProduct[]>([]);
  const [linkMap, setLinkMap] = useState<Record<string, string[]>>(links);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [notice, setNotice] = useState<string>();
  const [linkError, setLinkError] = useState<string>();
  const [linking, startLinking] = useTransition();
  const allSuppliers = [...suppliers, ...extraSuppliers.filter((extra) => !suppliers.some((known) => known.id === extra.id))];
  const allProducts = [...products, ...extraProducts.filter((extra) => !products.some((known) => known.id === extra.id))];
  const supplier = allSuppliers.find((candidate) => candidate.id === supplierId);
  const linkedIds = new Set(linkMap[supplierId] ?? []);
  const supplierProducts = allProducts.filter((candidate) => linkedIds.has(candidate.id));
  const byId = new Map(allProducts.map((product) => [product.id, product]));
  const addLink = (forSupplier: string, productIds: string[]) => setLinkMap((all) => ({ ...all, [forSupplier]: [...new Set([...(all[forSupplier] ?? []), ...productIds])] }));
  // Products already chosen on lines that this supplier does not supply: kept, never dropped silently.
  const unlinkedUsed = [...new Set(lines.map((line) => line.productId).filter((id) => id && !linkedIds.has(id)))];
  const fillLine = (key: number, product: PurchasableProduct) => update(key, { productId: product.id, unit: product.baseUnit, gstRateBp: String(product.gstRateBp) });
  const changeSupplier = (value: string) => {
    setSupplierId(value);
    setPanel(null);
    setNotice(undefined);
    setLinkError(undefined);
  };
  const linkUsed = () =>
    startLinking(async () => {
      const result = await linkSupplierProductsAction(supplierId, unlinkedUsed);
      if (result.ok) {
        addLink(supplierId, unlinkedUsed);
        setNotice(t("purchases.qc.linkedMany", { count: unlinkedUsed.length, supplier: supplier?.name ?? "" }));
        setLinkError(undefined);
      } else setLinkError(result.error);
    });
  const update = (key: number, patch: Partial<Line>) => {
    // Editing a field answers its message: drop it at once rather than leave it up until the next save.
    const edited = Object.keys(patch).map((field) => `${key}.${field}`).filter((name) => fieldErrors[name]);
    if (edited.length > 0) {
      const answered = edited.map((name) => fieldErrors[name]);
      setFieldErrors((all) => Object.fromEntries(Object.entries(all).filter(([name]) => !edited.includes(name))));
      setError((current) => (current && answered.includes(current) ? null : current));
    }
    setLines((all) => all.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  };
  const [godownId, setGodownId] = useState(() => godowns?.find((godown) => godown.isDefault)?.id ?? "");
  const included = lines.filter((line) => line.quantity.trim() !== "" && line.quantity.trim() !== "0");
  const totals = previewTotal(mode === "order" ? included.map((line) => ({ ...line, gstRateBp: "0" })) : included);

  const submit = () =>
    startTransition(async () => {
      const result =
        mode === "order"
          ? await createOrderAction({ idempotencyKey, supplierId, lines: included.map(({ productId, unit, quantity, cost }) => ({ productId, unit, quantity, cost })) })
          : await receiveGoodsAction({
              idempotencyKey,
              purchaseOrderId: order?.id ?? "",
              supplierId: order ? "" : supplierId,
              supplierBillNo: billNo,
              supplierBillDate: billDate,
              ...(godowns && godownId ? { godownId } : {}),
              lines: included.map((line) => ({ purchaseOrderLineId: line.purchaseOrderLineId, productId: line.productId, unit: line.unit, quantity: line.quantity, cost: line.cost, gstRateBp: line.gstRateBp })),
            });
      if (result.ok && result.id) {
        router.push(mode === "order" ? `/purchases/orders/${result.id}?new=1` : `/purchases/receipts/${result.id}?new=1`);
        return;
      }
      setError(result.error ?? t("purchases.notSaved"));
      // Map "lines.N" (index among included lines) back to the row keys on screen.
      const mapped: Record<string, string> = {};
      for (const [field, message] of Object.entries(result.fieldErrors ?? {})) {
        const match = /^lines\.(\d+)\.(\w+)$/.exec(field);
        if (match) mapped[`${included[Number(match[1])]?.key}.${match[2]}`] = message;
        else mapped[field] = message;
      }
      setFieldErrors(mapped);
    });

  return (
    <div className="flex flex-col gap-5">
      {order ? null : (
        <Field label={t("page.supplier")} error={fieldErrors.supplierId}>
          <select data-guide="purchase-supplier" value={supplierId} onChange={(event) => (event.target.value === ADD_SUPPLIER ? setPanel({ type: "supplier" }) : changeSupplier(event.target.value))} className={selectClass}>
            <option value="">{t("common.choose")}</option>
            {allSuppliers.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
            {quick?.canAddSupplier ? <option value={ADD_SUPPLIER}>{t("purchases.qc.addSupplier")}</option> : null}
          </select>
        </Field>
      )}
      {mode === "receipt" && godowns ? (
        <Field label={t("godown.receiveInto")} error={fieldErrors.godownId}>
          <select value={godownId} onChange={(event) => setGodownId(event.target.value)} className={selectClass}>
            {godowns.map((godown) => (
              <option key={godown.id} value={godown.id}>
                {godown.isDefault && godown.name === "Main Store" ? t("godown.mainStore") : godown.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {mode === "receipt" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={<span>{t("purchases.billNumber")} <span className="font-normal text-muted-foreground">{t("common.optional")}</span></span>} hint={t("purchases.billOnce")} error={fieldErrors.supplierBillNo}>
            <Input data-guide="purchase-bill-no" value={billNo} onChange={(event) => setBillNo(event.target.value)} maxLength={30} className="h-11 uppercase" />
          </Field>
          <Field label={<span>{t("purchases.billDate")} <span className="font-normal text-muted-foreground">{t("common.optional")}</span></span>} error={fieldErrors.supplierBillDate}>
            <Input data-guide="purchase-bill-date" type="date" value={billDate} onChange={(event) => setBillDate(event.target.value)} className="h-11" />
          </Field>
        </div>
      ) : null}

      {panel?.type === "supplier" ? (
        <QuickSupplierPanel
          onClose={() => setPanel(null)}
          onCreated={(created) => {
            setExtraSuppliers((all) => [...all, created]);
            setSupplierId(created.id);
            setPanel(null);
            setNotice(t("purchases.qc.supplierAdded", { name: created.name }));
          }}
        />
      ) : null}
      {panel && panel.type !== "supplier" && supplier ? (
        panel.type === "product" && quick?.productCreate ? (
          <QuickProductPanel
            supplier={supplier}
            options={quick.productCreate}
            onClose={() => setPanel(null)}
            onCreated={(created: QuickProduct) => {
              const unit = quick.productCreate!.units.find((candidate) => candidate.code === created.baseUnit);
              const product: PurchasableProduct = { ...created, units: [{ code: created.baseUnit, label: unit?.label ?? created.baseUnit }] };
              setExtraProducts((all) => [...all, product]);
              addLink(supplier.id, [product.id]);
              fillLine(panel.lineKey, product);
              setPanel(null);
              setNotice(t("purchases.qc.productAdded", { name: product.name }));
            }}
          />
        ) : panel.type === "link" ? (
          <LinkProductPanel
            supplier={supplier}
            candidates={allProducts.filter((candidate) => !linkedIds.has(candidate.id))}
            onClose={() => setPanel(null)}
            onLinked={(productId) => {
              const product = byId.get(productId);
              addLink(supplier.id, [productId]);
              if (product) fillLine(panel.lineKey, product);
              setPanel(null);
              setNotice(t("purchases.qc.linked", { name: product?.name ?? "", supplier: supplier.name }));
            }}
          />
        ) : null
      ) : null}
      {notice ? <FormAlert message={notice} /> : null}
      {!order && supplier && unlinkedUsed.length > 0 ? (
        <div data-guide="purchase-unlinked" className="flex flex-col gap-2 rounded-xl border border-amber/50 bg-muted/40 p-3 text-sm">
          <p className="text-foreground">{t("purchases.qc.unlinkedWarn", { count: unlinkedUsed.length, supplier: supplier.name })}</p>
          {quick?.canLinkProducts ? (
            <Button type="button" variant="outline" size="touch" className="self-start" disabled={linking} onClick={linkUsed}>
              {linking ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
              {t("purchases.qc.linkThem", { supplier: supplier.name })}
            </Button>
          ) : null}
          <FormAlert error={linkError} />
        </div>
      ) : null}

      <ol className="flex flex-col gap-3">
        {lines.map((line, index) => {
          const product = byId.get(line.productId);
          const orderLine = order?.lines.find((candidate) => candidate.id === line.purchaseOrderLineId);
          const err = (field: string) => fieldErrors[`${line.key}.${field}`];
          return (
            <li key={line.key} data-guide="purchase-line" className={`grid gap-3 rounded-xl border border-border p-3 ${mode === "receipt" ? "sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]" : "sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"} sm:items-start`}>
              {orderLine ? (
                <div className="min-w-0">
                  <p className="font-semibold text-foreground">{orderLine.productName}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("purchases.expectedLine", { qty: orderLine.leftBase, base: orderLine.baseUnitLabel, unit: orderLine.unitLabel })}
                  </p>
                  {err("productId") ? <p className="text-xs text-danger">{err("productId")}</p> : null}
                </div>
              ) : (
                <>
                  <Field label={t("common.productNumber", { number: index + 1 })} error={err("productId")}>
                    <select
                      data-guide="purchase-product"
                      value={line.productId}
                      onChange={(event) => {
                        const value = event.target.value;
                        if (value === ADD_PRODUCT || value === LINK_PRODUCT) {
                          setPanel({ type: value === ADD_PRODUCT ? "product" : "link", lineKey: line.key });
                          return;
                        }
                        const next = byId.get(value);
                        update(line.key, { productId: value, unit: next?.baseUnit ?? "", gstRateBp: String(next?.gstRateBp ?? 0) });
                      }}
                      className={selectClass}
                    >
                      <option value="">{t("common.choose")}</option>
                      {supplierProducts.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.name} ({option.sku})
                        </option>
                      ))}
                      {product && !linkedIds.has(product.id) ? (
                        <option value={product.id}>
                          {product.name} ({product.sku}) · {t("purchases.qc.notLinked")}
                        </option>
                      ) : null}
                      {supplier && quick?.canLinkProducts ? <option value={LINK_PRODUCT}>{"+ "}{t("purchases.qc.linkProduct")}</option> : null}
                      {supplier && quick?.productCreate ? <option value={ADD_PRODUCT}>{t("purchases.qc.addProduct")}</option> : null}
                    </select>
                    {!supplier ? <p className="mt-1 text-xs text-muted-foreground">{t("purchases.qc.chooseSupplier")}</p> : supplierProducts.length === 0 && !product ? <p className="mt-1 text-xs text-muted-foreground">{t("purchases.qc.none")}</p> : null}
                  </Field>
                </>
              )}
              {orderLine ? null : (
                <Field label={t("common.unit")} error={err("unit")}>
                  <select data-guide="purchase-unit" value={line.unit} onChange={(event) => update(line.key, { unit: event.target.value })} disabled={!product} className={selectClass}>
                    {product ? product.units.map((unit) => <option key={unit.code} value={unit.code}>{unit.label}</option>) : <option value="">—</option>}
                  </select>
                </Field>
              )}
              <Field label={mode === "receipt" ? t("purchases.receivedQty") : t("common.quantity")} error={err("quantity")}>
                <Input data-guide="purchase-qty" value={line.quantity} onChange={(event) => update(line.key, { quantity: event.target.value })} inputMode="decimal" placeholder="0" className="h-11 tabular-nums" />
              </Field>
              <Field help="purchasePrice" label={t("purchases.purchasePrice")} error={err("cost")}>
                <Input data-guide="purchase-cost" value={line.cost} onChange={(event) => update(line.key, { cost: event.target.value })} inputMode="decimal" placeholder={t("purchases.pricePlaceholder")} className="h-11 tabular-nums" />
              </Field>
              {mode === "receipt" ? (
                <Field label="GST" error={err("gstRateBp")}>
                  <select data-guide="purchase-gst" value={line.gstRateBp} onChange={(event) => update(line.key, { gstRateBp: event.target.value })} className={selectClass}>
                    {GST.map((rate) => (
                      <option key={rate} value={rate}>
                        {rate / 100}%
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}
              {!order && lines.length > 1 ? (
                <Button type="button" variant="ghost" size="touch" className="sm:mt-6" aria-label={t("common.removeLine", { line: index + 1 })} onClick={() => setLines((all) => all.filter((candidate) => candidate.key !== line.key))}>
                  <Trash2 aria-hidden="true" />
                </Button>
              ) : null}
            </li>
          );
        })}
      </ol>
      {order ? <p className="-mt-2 text-xs text-muted-foreground">{t("purchases.leaveEmpty")}</p> : null}
      {!order ? (
        <Button type="button" variant="outline" size="touch" className="self-start" onClick={() => setLines((all) => [...all, { key: Math.max(...all.map((line) => line.key)) + 1, productId: "", purchaseOrderLineId: "", unit: "", quantity: "", cost: "", gstRateBp: "0" }])}>
          <Plus aria-hidden="true" />
          {t("purchases.addItem")}
        </Button>
      ) : null}

      <div data-guide="purchase-total" className="flex flex-col gap-1 rounded-xl bg-muted/60 p-4 text-sm">
        {totals ? (
          <>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("common.value")}</span>
              <Money paise={totals.taxablePaise} withPaise />
            </div>
            {mode === "receipt" ? (
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t("purchases.gstInput")}</span>
                <Money paise={totals.gstPaise} withPaise />
              </div>
            ) : null}
            <div className="flex justify-between text-base font-bold text-foreground">
              <span>{mode === "receipt" ? t("purchases.addedToOwe") : t("purchases.orderValue")}</span>
              <Money paise={totals.totalPaise} withPaise />
            </div>
          </>
        ) : (
          <p className="text-muted-foreground">{t("purchases.enterToTotal")}</p>
        )}
      </div>

      <FormAlert error={error ?? undefined} />
      <Button data-guide="purchase-save" type="button" size="touch" className="self-start" disabled={pending || included.length === 0} onClick={submit}>
        {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
        {mode === "order" ? t("purchases.saveOrder") : t("suppliers.receiveGoods")}
      </Button>
      {mode === "receipt" ? <p className="text-xs text-muted-foreground">{t("purchases.receiveHelp")}</p> : null}
      {order ? <span className="sr-only">{order.supplierName}</span> : null}
    </div>
  );
}
