"use client";

import { cn } from "cn";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { GST_STATE_LIST, stateTaxLabel } from "@/shared/gst";
import { CircleAlert, FilePlus2, LoaderCircle, Minus, Plus, ReceiptText, Search, Trash2 } from "lucide-react";
import { previewBillAction, saveBillAction, searchProductsAction, type BillInputPayload } from "@/app/(app)/billing/actions";
import { Field, selectClass } from "@/components/catalog/form-bits";
import { Money } from "@/components/nexora/money";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { paiseToRupeeInput } from "@/shared/money";
import { cashSummary, emptyDraft, type Draft, type DraftLine, type Method } from "./billing-draft";
import type { BillView } from "@/modules/sales";

type Product = Awaited<ReturnType<typeof searchProductsAction>>["products"][number];
type Line = DraftLine<Product>;
type Customer = { id: string; name: string; type: string; area: string | null };

const METHODS: { key: Method; label: string }[] = [
  { key: "cash", label: "Cash" },
  { key: "upi", label: "UPI" },
  { key: "card", label: "Card" },
  { key: "bank", label: "Bank" },
];

/** Adds 1 to a quantity typed as text, without floating-point maths (whole part only). */
function bump(quantity: string, by: number): string {
  const match = /^(\d+)(\.\d+)?$/.exec(quantity.trim());
  if (!match) return by > 0 ? "1" : quantity;
  const next = Math.max(1, Number(match[1]) + by);
  return `${next}${match[2] ?? ""}`;
}

/**
 * Cache Components keeps visited pages alive (hidden) between navigations, so without this the last
 * draft would come back. Keying by `bfcacheId` starts a fresh bill on every "New bill" link or push,
 * while browser back/forward still restores an unfinished draft.
 */
/** `noProducts`: the shop has no products yet, so the empty bill says what to do first. */
type FirstRun = { noProducts: boolean; canAddProducts: boolean };

export function BillingScreen({ customers, firstRun = { noProducts: false, canAddProducts: false } }: { customers: Customer[]; firstRun?: FirstRun }) {
  const { bfcacheId } = useRouter();
  return <BillDraft key={bfcacheId} customers={customers} firstRun={firstRun} />;
}

function BillDraft({ customers, firstRun }: { customers: Customer[]; firstRun: FirstRun }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft<Product>>(emptyDraft);
  const { customerId, priceList, discountPercent, placeOfSupply, lines, payments, cashReceived, idempotencyKey } = draft;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Product[]>([]);
  const [bill, setBill] = useState<BillView | null>(null);
  const [billFor, setBillFor] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, startSaving] = useTransition();
  const [previewing, setPreviewing] = useState(false);
  const savingRef = useRef(false);
  const nextKey = useRef(1);

  const update = (patch: Partial<Draft<Product>>) => setDraft((current) => ({ ...current, ...patch }));
  const setLines = (change: (current: Line[]) => Line[]) => setDraft((current) => ({ ...current, lines: change(current.lines) }));
  const setPayment = (method: Method, value: string) => setDraft((current) => ({ ...current, payments: { ...current.payments, [method]: value } }));

  /** Starts a fresh bill with a new Idempotency-Key. Saved bills live on the server and are untouched. */
  const resetBill = () => {
    setDraft(emptyDraft());
    setQuery("");
    setResults([]);
    setBill(null);
    setBillFor("");
    setError(null);
    setFieldErrors({});
  };

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

  // Live preview from the server whenever the bill changes, debounced. Keyed on the payload's text
  // so a re-render that rebuilds an equal payload doesn't ask again.
  useEffect(() => {
    const body = JSON.parse(payloadKey) as BillInputPayload;
    if (body.lines.length === 0) return;
    let stale = false;
    const timer = setTimeout(async () => {
      setPreviewing(true);
      const result = await previewBillAction(body);
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
  }, [payloadKey]);

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
  // `shown` keeps the last server bill on screen while the next preview is on its way, so the
  // summary and payment inputs don't blink, get disabled or lose focus on every keystroke. Only
  // `current`, the bill for exactly what is typed now, can be saved.
  const shown = lines.length > 0 ? bill : null;
  const current = shown && billFor === payloadKey ? shown : null;
  const problems = shown?.problems ?? [];
  const lineProblem = (index: number) => problems.find((problem) => problem.field === `lines.${index}.quantity`)?.message ?? fieldErrors[`lines.${index}.quantity`];
  const cash = payments.cash ? cashSummary(payments.cash, cashReceived) : null;
  const cashShort = (cash?.shortPaise ?? 0) > 0;
  const canSave = Boolean(current) && problems.length === 0 && !cashShort && !saving && !previewing;

  const fillPayment = (method: Method | "credit") => {
    if (!shown) return;
    const empty = { cash: "", upi: "", card: "", bank: "" };
    update({ payments: method === "credit" ? empty : { ...empty, [method]: paiseToRupeeInput(shown.totals.totalPaise) }, ...(method === "cash" ? {} : { cashReceived: "" }) });
  };

  const save = () => {
    // The ref stops a second click that lands before React re-renders with `saving` set. The server
    // is the real guard: the same Idempotency-Key replays the saved bill instead of saving again.
    if (!current || savingRef.current) return;
    savingRef.current = true;
    startSaving(async () => {
      try {
        const result = await saveBillAction({ ...payload, idempotencyKey, expectedTotalPaise: current.totals.totalPaise, expectedRates: current.expectedRates });
        if (result.invoiceId) {
          resetBill();
          router.push(`/billing/invoices/${result.invoiceId}?new=1`);
          return;
        }
        if (result.bill) {
          // Prices, stock or dues changed: show the server's new bill; the cashier saves again after checking.
          setBill(result.bill);
          setBillFor(payloadKey);
        }
        // The key stays with the draft. A refused bill saved nothing, so the key is free to use again;
        // changing it here could save a bill twice when the first save was only slow.
        setError(
          result.code === "IDEMPOTENCY_CONFLICT"
            ? "This bill was already saved, then changed. Check Bills before saving again, or start a new bill."
            : (result.error ?? "The bill was not saved."),
        );
      } catch {
        setError("Couldn't reach the server. Check the connection and press Save again. The bill won't be saved twice.");
      } finally {
        savingRef.current = false;
      }
    });
  };

  const customer = customers.find((candidate) => candidate.id === customerId);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(20rem,1fr)]">
      <section aria-label="Items" className="flex min-w-0 flex-col gap-4 rounded-2xl border border-border bg-card p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold text-foreground">Items{lines.length > 0 ? ` (${lines.length})` : ""}</h2>
          <Button type="button" variant="outline" size="touch" onClick={resetBill} disabled={saving}>
            <FilePlus2 aria-hidden="true" />
            New bill
          </Button>
        </div>
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
            {firstRun.noProducts ? (
              <>
                <p className="font-semibold text-foreground">Add a product first</p>
                <p className="max-w-sm text-sm text-muted-foreground">
                  {firstRun.canAddProducts ? "A bill needs a product with a selling price and some stock. Add your first product and its opening stock, then come back here to bill it." : "There are no products to sell yet. Ask the owner to add products first."}
                </p>
                {firstRun.canAddProducts ? (
                  <Link href="/inventory/new" className={buttonVariants({ size: "touch" })}>
                    Add your first product
                  </Link>
                ) : null}
              </>
            ) : (
              <>
                <p className="font-semibold text-foreground">No items yet</p>
                <p className="text-sm text-muted-foreground">Search above to add products. Adding the same product again adds 1 to its quantity.</p>
              </>
            )}
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {lines.map((line, index) => {
              const priced = shown?.lines[index]?.productId === line.product.id ? shown.lines[index] : undefined;
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
            <select value={customerId} onChange={(event) => update({ customerId: event.target.value })} className={selectClass}>
              <option value="">Walk-in customer</option>
              {customers.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name} ({option.type}){option.area ? ` · ${option.area}` : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Price list">
            <select value={priceList} onChange={(event) => update({ priceList: event.target.value })} className={selectClass}>
              <option value="">{customer?.type === "wholesale" ? "Wholesale (auto)" : "Retail (auto)"}</option>
              <option value="retail">Retail</option>
              <option value="wholesale">Wholesale</option>
            </select>
          </Field>
          <Field label="Bill discount (%)" error={problems.find((problem) => problem.field === "discountPercent")?.message ?? fieldErrors.discountPercent}>
            <Input value={discountPercent} onChange={(event) => update({ discountPercent: event.target.value })} inputMode="decimal" placeholder="0" className="h-11 tabular-nums" />
          </Field>
          {bill?.interStateSales || placeOfSupply ? (
            <Field label="Place of supply" error={problems.find((problem) => problem.field === "placeOfSupply")?.message}>
              <select value={placeOfSupply} onChange={(event) => update({ placeOfSupply: event.target.value })} className={selectClass}>
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
          {shown ? (
            <>
              <Row label="Subtotal" paise={shown.totals.subtotalPaise} />
              {shown.totals.discountPaise > 0 ? <Row label={`Discount`} paise={-shown.totals.discountPaise} /> : null}
              <Row label="Taxable value" paise={shown.totals.taxablePaise} />
              {shown.taxMode === "intra" ? (
                <>
                  <Row label="CGST" paise={shown.totals.cgstPaise} />
                  <Row label={stateTaxLabel(shown.shopStateCode)} paise={shown.totals.sgstPaise} />
                </>
              ) : null}
              {shown.taxMode === "inter" ? <Row label="IGST" paise={shown.totals.igstPaise} /> : null}
              {shown.taxMode === "none" ? <p className="text-xs text-muted-foreground">Bill of Supply: no GST is charged.</p> : null}
              {shown.totals.roundOffPaise !== 0 ? <Row label="Round off" paise={shown.totals.roundOffPaise} /> : null}
              <div className="mt-1 flex items-baseline justify-between border-t border-border pt-2">
                <dt className="font-semibold text-foreground">Total</dt>
                <dd className="text-2xl font-bold text-foreground">
                  <Money paise={shown.totals.totalPaise} />
                </dd>
              </div>
            </>
          ) : (
            <p className="text-muted-foreground">{lines.length === 0 ? "Add items to see the total." : previewing ? "Working out the bill…" : "Check the items above."}</p>
          )}
        </dl>

        <fieldset className="flex flex-col gap-2 border-t border-border pt-3" disabled={!shown}>
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
                <Input value={payments[method.key]} onChange={(event) => setPayment(method.key, event.target.value)} inputMode="decimal" placeholder="0" className="h-11 tabular-nums" />
              </Field>
            ))}
          </div>
          {payments.cash ? (
            <Field
              label="Cash received (₹)"
              hint="Only to work out change. Not saved."
              error={cashShort ? `₹${paiseToRupeeInput(cash!.shortPaise)} short. Take more cash or put the rest on UPI or credit.` : problems.find((problem) => problem.field === "cashReceived")?.message}
            >
              <Input value={cashReceived} onChange={(event) => update({ cashReceived: event.target.value })} inputMode="decimal" placeholder={payments.cash} className="h-11 tabular-nums" />
            </Field>
          ) : null}
          {shown ? (
            <div className="flex flex-col gap-1 text-sm">
              <Row label="Paid now" paise={shown.paidNowPaise} />
              <Row label="On credit" paise={shown.creditPaise} />
              {cash && !cashShort ? <Row label="Change to return" paise={cash.changePaise} strong /> : null}
              {shown.balanceAfterPaise !== null ? <Row label="Customer dues after this bill" paise={shown.balanceAfterPaise} /> : null}
            </div>
          ) : null}
        </fieldset>

        {problems.filter((problem) => !problem.field?.startsWith("lines.") && problem.field !== "cashReceived").length > 0 || error ? (
          <div role="alert" className="flex flex-col gap-1 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">
            {error ? (
              <p className="flex gap-2">
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                {error}
              </p>
            ) : null}
            {problems
              .filter((problem) => !problem.field?.startsWith("lines.") && problem.field !== "cashReceived" && problem.message !== error)
              .map((problem) => (
                <p key={problem.code}>{problem.message}</p>
              ))}
          </div>
        ) : null}

        <Button type="button" size="touch" className="h-12 text-base" disabled={!canSave} onClick={save}>
          {saving ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
          {shown ? "Save bill · " : "Save bill"}
          {shown ? <Money paise={shown.totals.totalPaise} /> : null}
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
