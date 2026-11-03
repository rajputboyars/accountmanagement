"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { LoaderCircle, Plus, Trash2 } from "lucide-react";
import { createOrderAction, receiveGoodsAction } from "@/app/(app)/purchases/actions";
import { Field, FormAlert, selectClass } from "@/components/catalog/form-bits";
import { useT } from "@/components/nexora/language-provider";
import { Money } from "@/components/nexora/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseRupeesToPaise } from "@/shared/money";
import { computePurchaseTotals } from "@/shared/purchase";
import { parseQuantity } from "@/shared/quantity";
import { STATUTORY_GST_RATES_BP } from "@/shared/gst";

export type PurchasableProduct = { id: string; name: string; sku: string; baseUnit: string; gstRateBp: number; units: { code: string; label: string }[] };
export type OrderLineForReceipt = { id: string; productName: string; unit: string; baseUnit: string; leftBase: string; leftInUnit: string | null; costPaisePerUnit: number; gstRateBp: number; unitLabel: string; baseUnitLabel: string };

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
}: {
  mode: "order" | "receipt";
  defaultSupplierId?: string;
  suppliers: { id: string; name: string }[];
  products: PurchasableProduct[];
  order?: { id: string; supplierName: string; lines: OrderLineForReceipt[] };
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
  const byId = new Map(products.map((product) => [product.id, product]));
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
          <select data-guide="purchase-supplier" value={supplierId} onChange={(event) => setSupplierId(event.target.value)} className={selectClass}>
            <option value="">{t("common.choose")}</option>
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name}
              </option>
            ))}
          </select>
        </Field>
      )}
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
                        const next = byId.get(event.target.value);
                        update(line.key, { productId: event.target.value, unit: next?.baseUnit ?? "", gstRateBp: String(next?.gstRateBp ?? 0) });
                      }}
                      className={selectClass}
                    >
                      <option value="">{t("common.choose")}</option>
                      {products.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.name} ({option.sku})
                        </option>
                      ))}
                    </select>
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
