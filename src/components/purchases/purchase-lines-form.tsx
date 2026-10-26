"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { LoaderCircle, Plus, Trash2 } from "lucide-react";
import { createOrderAction, receiveGoodsAction } from "@/app/(app)/purchases/actions";
import { Field, FormAlert, selectClass } from "@/components/catalog/form-bits";
import { Money } from "@/components/nexora/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseRupeesToPaise } from "@/shared/money";
import { computePurchaseTotals } from "@/shared/purchase";
import { parseQuantity } from "@/shared/quantity";
import { STATUTORY_GST_RATES_BP } from "@/shared/gst";

export type PurchasableProduct = { id: string; name: string; sku: string; baseUnit: string; gstRateBp: number; units: { code: string; label: string }[] };
export type OrderLineForReceipt = { id: string; productName: string; unit: string; baseUnit: string; leftBase: string; leftInUnit: string | null; costPaisePerUnit: number; gstRateBp: number };

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
  const update = (key: number, patch: Partial<Line>) => setLines((all) => all.map((line) => (line.key === key ? { ...line, ...patch } : line)));
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
      setError(result.error ?? "Not saved.");
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
        <Field label="Supplier" error={fieldErrors.supplierId}>
          <select value={supplierId} onChange={(event) => setSupplierId(event.target.value)} className={selectClass}>
            <option value="">Choose…</option>
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
          <Field label={<span>Supplier&apos;s bill number <span className="font-normal text-muted-foreground">(optional)</span></span>} hint="A bill can be entered only once per supplier." error={fieldErrors.supplierBillNo}>
            <Input value={billNo} onChange={(event) => setBillNo(event.target.value)} maxLength={30} className="h-11 uppercase" />
          </Field>
          <Field label={<span>Bill date <span className="font-normal text-muted-foreground">(optional)</span></span>} error={fieldErrors.supplierBillDate}>
            <Input type="date" value={billDate} onChange={(event) => setBillDate(event.target.value)} className="h-11" />
          </Field>
        </div>
      ) : null}

      <ol className="flex flex-col gap-3">
        {lines.map((line, index) => {
          const product = byId.get(line.productId);
          const orderLine = order?.lines.find((candidate) => candidate.id === line.purchaseOrderLineId);
          const err = (field: string) => fieldErrors[`${line.key}.${field}`];
          return (
            <li key={line.key} className={`grid gap-3 rounded-xl border border-border p-3 ${mode === "receipt" ? "sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]" : "sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"} sm:items-start`}>
              {orderLine ? (
                <div className="min-w-0">
                  <p className="font-semibold text-foreground">{orderLine.productName}</p>
                  <p className="text-xs text-muted-foreground">
                    Still expected: {orderLine.leftBase} {orderLine.baseUnit} · in {orderLine.unit}
                  </p>
                  {err("productId") ? <p className="text-xs text-danger">{err("productId")}</p> : null}
                </div>
              ) : (
                <>
                  <Field label={`Product ${index + 1}`} error={err("productId")}>
                    <select
                      value={line.productId}
                      onChange={(event) => {
                        const next = byId.get(event.target.value);
                        update(line.key, { productId: event.target.value, unit: next?.baseUnit ?? "", gstRateBp: String(next?.gstRateBp ?? 0) });
                      }}
                      className={selectClass}
                    >
                      <option value="">Choose…</option>
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
                <Field label="Unit" error={err("unit")}>
                  <select value={line.unit} onChange={(event) => update(line.key, { unit: event.target.value })} disabled={!product} className={selectClass}>
                    {product ? product.units.map((unit) => <option key={unit.code} value={unit.code}>{unit.label}</option>) : <option value="">—</option>}
                  </select>
                </Field>
              )}
              <Field label={mode === "receipt" ? "Received" : "Quantity"} error={err("quantity")}>
                <Input value={line.quantity} onChange={(event) => update(line.key, { quantity: event.target.value })} inputMode="decimal" placeholder="0" className="h-11 tabular-nums" />
              </Field>
              <Field label="Cost per unit (₹)" error={err("cost")}>
                <Input value={line.cost} onChange={(event) => update(line.key, { cost: event.target.value })} inputMode="decimal" placeholder="e.g. 22" className="h-11 tabular-nums" />
              </Field>
              {mode === "receipt" ? (
                <Field label="GST" error={err("gstRateBp")}>
                  <select value={line.gstRateBp} onChange={(event) => update(line.key, { gstRateBp: event.target.value })} className={selectClass}>
                    {GST.map((rate) => (
                      <option key={rate} value={rate}>
                        {rate / 100}%
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}
              {!order && lines.length > 1 ? (
                <Button type="button" variant="ghost" size="touch" className="sm:mt-6" aria-label={`Remove line ${index + 1}`} onClick={() => setLines((all) => all.filter((candidate) => candidate.key !== line.key))}>
                  <Trash2 aria-hidden="true" />
                </Button>
              ) : null}
            </li>
          );
        })}
      </ol>
      {order ? <p className="-mt-2 text-xs text-muted-foreground">Leave a quantity empty or 0 for items that didn&apos;t come. The rest stays expected (&quot;received · short&quot;).</p> : null}
      {!order ? (
        <Button type="button" variant="outline" size="touch" className="self-start" onClick={() => setLines((all) => [...all, { key: Math.max(...all.map((line) => line.key)) + 1, productId: "", purchaseOrderLineId: "", unit: "", quantity: "", cost: "", gstRateBp: "0" }])}>
          <Plus aria-hidden="true" />
          Add another item
        </Button>
      ) : null}

      <div className="flex flex-col gap-1 rounded-xl bg-muted/60 p-4 text-sm">
        {totals ? (
          <>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Value</span>
              <Money paise={totals.taxablePaise} withPaise />
            </div>
            {mode === "receipt" ? (
              <div className="flex justify-between">
                <span className="text-muted-foreground">GST input</span>
                <Money paise={totals.gstPaise} withPaise />
              </div>
            ) : null}
            <div className="flex justify-between text-base font-bold text-foreground">
              <span>{mode === "receipt" ? "Added to what you owe the supplier" : "Order value"}</span>
              <Money paise={totals.totalPaise} withPaise />
            </div>
          </>
        ) : (
          <p className="text-muted-foreground">Enter quantities and costs to see the total.</p>
        )}
      </div>

      <FormAlert error={error ?? undefined} />
      <Button type="button" size="touch" className="self-start" disabled={pending || included.length === 0} onClick={submit}>
        {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
        {mode === "order" ? "Save order" : "Receive goods"}
      </Button>
      {mode === "receipt" ? <p className="text-xs text-muted-foreground">Stock goes up, the cost price becomes the weighted average, and the bill is added to the supplier&apos;s account, all in one step.</p> : null}
      {order ? <span className="sr-only">{order.supplierName}</span> : null}
    </div>
  );
}
