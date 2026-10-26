"use client";

import { cn } from "cn";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { GST_STATE_LIST, stateTaxLabel } from "@/shared/gst";
import { CircleAlert, LoaderCircle, Minus, Plus, ReceiptText, Search, Trash2 } from "lucide-react";
import { previewBillAction, saveBillAction, searchProductsAction, type BillInputPayload } from "@/app/(app)/billing/actions";
import { Field, selectClass } from "@/components/catalog/form-bits";
import { Money } from "@/components/nexora/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { paiseToRupeeInput } from "@/shared/money";
import type { BillView } from "@/modules/sales";

type Product = Awaited<ReturnType<typeof searchProductsAction>>["products"][number];
type Line = { key: number; product: Product; unit: string; quantity: string };
type Customer = { id: string; name: string; type: string; area: string | null };
type Method = "cash" | "upi" | "card" | "bank";

const METHODS: { key: Method; label: string }[] = [
  { key: "cash", label: "Cash" },
  { key: "upi", label: "UPI" },
  { key: "card", label: "Card" },
  { key: "bank", label: "Bank" },
];

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "") : `${Date.now()}${Math.random().toString(36).slice(2)}`);

/** Adds 1 to a quantity typed as text, without floating-point maths (whole part only). */
function bump(quantity: string, by: number): string {
  const match = /^(\d+)(\.\d+)?$/.exec(quantity.trim());
  if (!match) return by > 0 ? "1" : quantity;
  const next = Math.max(1, Number(match[1]) + by);
  return `${next}${match[2] ?? ""}`;
}

export function BillingScreen({ customers }: { customers: Customer[] }) {
  const router = useRouter();
  const [customerId, setCustomerId] = useState("");
  const [priceList, setPriceList] = useState("");
  const [discountPercent, setDiscountPercent] = useState("");
  const [placeOfSupply, setPlaceOfSupply] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [payments, setPayments] = useState<Record<Method, string>>({ cash: "", upi: "", card: "", bank: "" });
  const [cashReceived, setCashReceived] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Product[]>([]);
  const [bill, setBill] = useState<BillView | null>(null);
  const [billFor, setBillFor] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);
  const [saving, startSaving] = useTransition();
  const [previewing, setPreviewing] = useState(false);
  const nextKey = useRef(1);

  const payload: BillInputPayload = useMemo(
    () => ({ customerId, priceList, discountPercent, lines: lines.map((line) => ({ productId: line.product.id, unit: line.unit, quantity: line.quantity })), payments, cashReceived, placeOfSupply }),
    [customerId, priceList, discountPercent, lines, payments, cashReceived, placeOfSupply],
  );
  const payloadKey = JSON.stringify(payload);

  // Product search (server), debounced.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const timer = setTimeout(async () => {
      const result = await searchProductsAction(q);
      setResults(result.products);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  // Live preview from the server whenever the bill changes, debounced.
  useEffect(() => {
    if (payload.lines.length === 0) return;
    let stale = false;
    const timer = setTimeout(async () => {
      setPreviewing(true);
      const result = await previewBillAction(payload);
      if (stale) return;
      setPreviewing(false);
      if (result.bill) {
        setBill(result.bill);
        setBillFor(payloadKey);
        setError(null);
        setFieldErrors({});
      } else {
        setBill(null);
        setError(result.error ?? "The bill could not be worked out.");
        setFieldErrors(result.fieldErrors ?? {});
      }
    }, 300);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [payload, payloadKey]);

  const addProduct = (product: Product) => {
    setLines((current) => {
      const existing = current.find((line) => line.product.id === product.id);
      if (existing) return current.map((line) => (line.key === existing.key ? { ...line, quantity: bump(line.quantity, 1) } : line));
      return [...current, { key: nextKey.current++, product, unit: product.baseUnit, quantity: "1" }];
    });
    setQuery("");
    setResults([]);
  };

  const setLine = (key: number, patch: Partial<Line>) => setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  const current = bill && billFor === payloadKey && lines.length > 0 ? bill : null;
  const problems = current?.problems ?? [];
  const lineProblem = (index: number) => problems.find((problem) => problem.field === `lines.${index}.quantity`)?.message ?? fieldErrors[`lines.${index}.quantity`];
  const canSave = Boolean(current) && problems.length === 0 && !saving && !previewing;

  const fillPayment = (method: Method | "credit") => {
    if (!current) return;
    const empty = { cash: "", upi: "", card: "", bank: "" };
    setPayments(method === "credit" ? empty : { ...empty, [method]: paiseToRupeeInput(current.totals.totalPaise) });
  };

  const save = () => {
    if (!current) return;
    startSaving(async () => {
      const result = await saveBillAction({ ...payload, idempotencyKey, expectedTotalPaise: current.totals.totalPaise, expectedRates: current.expectedRates });
      if (result.invoiceId) {
        router.push(`/billing/invoices/${result.invoiceId}?new=1`);
        return;
      }
      if (result.bill) {
        // Prices, stock or dues changed: show the server's new bill; the cashier saves again after checking.
        setBill(result.bill);
        setBillFor(payloadKey);
      }
      setError(result.error ?? "The bill was not saved.");
      if (result.code !== "PRICE_CHANGED") setIdempotencyKey(newKey());
    });
  };

  const customer = customers.find((candidate) => candidate.id === customerId);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(20rem,1fr)]">
      <section aria-label="Items" className="flex min-w-0 flex-col gap-4 rounded-2xl border border-border bg-card p-4 sm:p-5">
        <div className="relative">
          <label className="relative block">
            <span className="sr-only">Search products</span>
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name, code or barcode" className="h-12 pl-9 text-base" autoComplete="off" />
          </label>
          {query.trim().length >= 2 && results.length > 0 ? (
            <ul role="listbox" aria-label="Matching products" className="absolute inset-x-0 top-full z-20 mt-1 max-h-80 overflow-y-auto rounded-xl border border-border bg-card shadow-lg">
              {results.map((product) => (
                <li key={product.id}>
                  <button type="button" role="option" aria-selected="false" onClick={() => addProduct(product)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-muted">
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-foreground">{product.name}</span>
                      <span className="block text-xs text-muted-foreground">{product.sku}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{product.stockQty === null ? "Not counted" : `${product.stockQty} ${product.baseUnit} in stock`}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {lines.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-12 text-center">
            <ReceiptText className="size-8 text-muted-foreground" aria-hidden="true" />
            <p className="font-semibold text-foreground">No items yet</p>
            <p className="text-sm text-muted-foreground">Search above to add products. Adding the same product again adds 1 to its quantity.</p>
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {lines.map((line, index) => {
              const priced = current?.lines[index];
              const problem = lineProblem(index);
              return (
                <li key={line.key} className="flex flex-col gap-2 py-3 first:pt-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-foreground">{line.product.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {line.product.sku} · {line.product.stockQty === null ? "not counted" : `${line.product.stockQty} ${line.product.baseUnit} in stock`}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      {priced ? (
                        <>
                          <Money paise={priced.amountPaise} withPaise className="font-semibold text-foreground" />
                          <p className="text-xs text-muted-foreground">
                            <Money paise={priced.ratePaise} withPaise /> / {priced.unitName.toLowerCase()}
                          </p>
                        </>
                      ) : (
                        <span className="text-sm text-muted-foreground">…</span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex items-center rounded-lg border border-input">
                      <Button type="button" variant="ghost" size="touch" aria-label={`One less ${line.product.name}`} onClick={() => setLine(line.key, { quantity: bump(line.quantity, -1) })}>
                        <Minus aria-hidden="true" />
                      </Button>
                      <Input
                        value={line.quantity}
                        onChange={(event) => setLine(line.key, { quantity: event.target.value })}
                        inputMode="decimal"
                        aria-label={`Quantity of ${line.product.name}`}
                        aria-invalid={problem ? true : undefined}
                        className="h-11 w-20 border-0 text-center tabular-nums"
                      />
                      <Button type="button" variant="ghost" size="touch" aria-label={`One more ${line.product.name}`} onClick={() => setLine(line.key, { quantity: bump(line.quantity, 1) })}>
                        <Plus aria-hidden="true" />
                      </Button>
                    </div>
                    <select aria-label={`Unit for ${line.product.name}`} value={line.unit} onChange={(event) => setLine(line.key, { unit: event.target.value })} className={cn(selectClass, "w-auto min-w-28")}>
                      {line.product.units.map((unit) => (
                        <option key={unit.code} value={unit.code}>
                          {unit.label}
                        </option>
                      ))}
                    </select>
                    {priced ? <Badge variant="info">{priced.rateReason}</Badge> : null}
                    {priced && priced.unit !== priced.baseUnit ? <span className="text-xs text-muted-foreground">= {priced.baseQuantity} {priced.baseUnit}</span> : null}
                    <Button type="button" variant="ghost" size="touch" className="ml-auto" aria-label={`Remove ${line.product.name}`} onClick={() => setLines((all) => all.filter((candidate) => candidate.key !== line.key))}>
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </div>
                  {problem ? (
                    <p role="alert" className="text-sm text-danger">
                      {problem}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-label="Bill summary" className="flex flex-col gap-4 self-start rounded-2xl border border-border bg-card p-4 sm:p-5 lg:sticky lg:top-20">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Customer" className="col-span-2" error={problems.find((problem) => problem.field === "customerId")?.message}>
            <select value={customerId} onChange={(event) => setCustomerId(event.target.value)} className={selectClass}>
              <option value="">Walk-in customer</option>
              {customers.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name} ({option.type}){option.area ? ` · ${option.area}` : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Price list">
            <select value={priceList} onChange={(event) => setPriceList(event.target.value)} className={selectClass}>
              <option value="">{customer?.type === "wholesale" ? "Wholesale (auto)" : "Retail (auto)"}</option>
              <option value="retail">Retail</option>
              <option value="wholesale">Wholesale</option>
            </select>
          </Field>
          <Field label="Bill discount (%)" error={problems.find((problem) => problem.field === "discountPercent")?.message ?? fieldErrors.discountPercent}>
            <Input value={discountPercent} onChange={(event) => setDiscountPercent(event.target.value)} inputMode="decimal" placeholder="0" className="h-11 tabular-nums" />
          </Field>
          {bill?.interStateSales || placeOfSupply ? (
            <Field label="Place of supply" error={problems.find((problem) => problem.field === "placeOfSupply")?.message}>
              <select value={placeOfSupply} onChange={(event) => setPlaceOfSupply(event.target.value)} className={selectClass}>
                <option value="">This shop&apos;s state (counter sale)</option>
                {GST_STATE_LIST
                  .filter(([code]) => code !== bill?.shopStateCode)
                  .map(([code, name]) => (
                    <option key={code} value={code}>
                      Delivered to {name} (IGST)
                    </option>
                  ))}
              </select>
            </Field>
          ) : null}
        </div>

        <dl className="flex flex-col gap-1.5 border-t border-border pt-3 text-sm">
          {current ? (
            <>
              <Row label="Subtotal" paise={current.totals.subtotalPaise} />
              {current.totals.discountPaise > 0 ? <Row label={`Discount`} paise={-current.totals.discountPaise} /> : null}
              <Row label="Taxable value" paise={current.totals.taxablePaise} />
              {current.taxMode === "intra" ? (
                <>
                  <Row label="CGST" paise={current.totals.cgstPaise} />
                  <Row label={stateTaxLabel(current.shopStateCode)} paise={current.totals.sgstPaise} />
                </>
              ) : null}
              {current.taxMode === "inter" ? <Row label="IGST" paise={current.totals.igstPaise} /> : null}
              {current.taxMode === "none" ? <p className="text-xs text-muted-foreground">Bill of Supply: no GST is charged.</p> : null}
              {current.totals.roundOffPaise !== 0 ? <Row label="Round off" paise={current.totals.roundOffPaise} /> : null}
              <div className="mt-1 flex items-baseline justify-between border-t border-border pt-2">
                <dt className="font-semibold text-foreground">Total</dt>
                <dd className="text-2xl font-bold text-foreground">
                  <Money paise={current.totals.totalPaise} />
                </dd>
              </div>
            </>
          ) : (
            <p className="text-muted-foreground">{lines.length === 0 ? "Add items to see the total." : previewing ? "Working out the bill…" : "Check the items above."}</p>
          )}
        </dl>

        <fieldset className="flex flex-col gap-2 border-t border-border pt-3" disabled={!current}>
          <legend className="text-sm font-semibold text-foreground">Payment now</legend>
          <div className="flex flex-wrap gap-2">
            {METHODS.slice(0, 2).map((method) => (
              <Button key={method.key} type="button" variant="outline" size="sm" onClick={() => fillPayment(method.key)}>
                All {method.label}
              </Button>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => fillPayment("credit")} disabled={!customerId}>
              All on credit
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {METHODS.map((method) => (
              <Field key={method.key} label={`${method.label} (₹)`}>
                <Input value={payments[method.key]} onChange={(event) => setPayments((all) => ({ ...all, [method.key]: event.target.value }))} inputMode="decimal" placeholder="0" className="h-11 tabular-nums" />
              </Field>
            ))}
          </div>
          {payments.cash ? (
            <Field label="Cash received (₹)" hint="Only to work out change. Not saved." error={problems.find((problem) => problem.field === "cashReceived")?.message}>
              <Input value={cashReceived} onChange={(event) => setCashReceived(event.target.value)} inputMode="decimal" className="h-11 tabular-nums" />
            </Field>
          ) : null}
          {current ? (
            <div className="flex flex-col gap-1 text-sm">
              <Row label="Paid now" paise={current.paidNowPaise} />
              <Row label="On credit" paise={current.creditPaise} />
              {current.changePaise !== null && current.changePaise > 0 ? <Row label="Change to return" paise={current.changePaise} strong /> : null}
              {current.balanceAfterPaise !== null ? <Row label="Customer dues after this bill" paise={current.balanceAfterPaise} /> : null}
            </div>
          ) : null}
        </fieldset>

        {problems.filter((problem) => !problem.field?.startsWith("lines.")).length > 0 || error ? (
          <div role="alert" className="flex flex-col gap-1 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">
            {error ? (
              <p className="flex gap-2">
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                {error}
              </p>
            ) : null}
            {problems
              .filter((problem) => !problem.field?.startsWith("lines.") && problem.message !== error)
              .map((problem) => (
                <p key={problem.code}>{problem.message}</p>
              ))}
          </div>
        ) : null}

        <Button type="button" size="touch" className="h-12 text-base" disabled={!canSave} onClick={save}>
          {saving ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
          {current ? "Save bill · " : "Save bill"}
          {current ? <Money paise={current.totals.totalPaise} /> : null}
        </Button>
        <p className="text-xs text-muted-foreground">Prices, stock and dues are checked again when you save. If anything changed, nothing is saved and the new total is shown.</p>
      </section>
    </div>
  );
}

function Row({ label, paise, strong = false }: { label: string; paise: number; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={strong ? "font-semibold text-foreground" : "text-foreground"}>
        <Money paise={paise} withPaise />
      </dd>
    </div>
  );
}
