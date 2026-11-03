"use client";

import { cn } from "cn";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { GST_STATE_LIST, stateTaxLabel } from "@/shared/gst";
import { stateName } from "@/shared/i18n/unit-labels";
import { CircleAlert, FilePlus2, LoaderCircle, Minus, Plus, ReceiptText, Search, Trash2 } from "lucide-react";
import { previewBillAction, saveBillAction, searchProductsAction, type BillInputPayload } from "@/app/(app)/billing/actions";
import { Field, selectClass } from "@/components/catalog/form-bits";
import { useT } from "@/components/nexora/language-provider";
import { Money } from "@/components/nexora/money";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatPaise, paiseToRupeeInput } from "@/shared/money";
import { billingBannerProblems, cashSummary, emptyDraft, unreadableAmounts, type Draft, type DraftLine, type Method } from "./billing-draft";
import type { MessageKey } from "@/shared/i18n/messages/en";
import type { BillView } from "@/modules/sales";
import { HelpHint } from "@/components/nexora/help-hint";
import type { HelpTopic } from "@/shared/i18n/help";

type Product = Awaited<ReturnType<typeof searchProductsAction>>["products"][number];
type Line = DraftLine<Product>;
type Customer = { id: string; name: string; type: string; area: string | null };

const METHODS: { key: Method; label: MessageKey }[] = [
  { key: "cash", label: "common.cash" },
  { key: "upi", label: "common.upi" },
  { key: "card", label: "common.card" },
  { key: "bank", label: "common.bank" },
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
  const t = useT();
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
  // Unreadable amounts stay as typed and are pointed out in place; nothing is asked of the server until they are corrected.
  const unreadable = unreadableAmounts({ payments, cashReceived });
  const hasUnreadable = Object.keys(unreadable).length > 0;

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
    if (Object.keys(unreadableAmounts({ payments: body.payments, cashReceived: body.cashReceived })).length > 0) return;
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
        setError(result.error ?? t("billing.errorWorkingOut"));
        setFieldErrors(result.fieldErrors ?? {});
      }
    }, 300);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [payloadKey, t]);

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
  const customerProblem = problems.find((problem) => problem.field === "customerId");
  const bannerProblems = billingBannerProblems(problems);
  const lineProblem = (index: number) => problems.find((problem) => problem.field === `lines.${index}.quantity`)?.message ?? fieldErrors[`lines.${index}.quantity`];
  const cash = payments.cash ? cashSummary(payments.cash, cashReceived) : null;
  const cashShort = (cash?.shortPaise ?? 0) > 0;
  const canSave = Boolean(current) && !hasUnreadable && problems.length === 0 && !cashShort && !saving && !previewing;

  const fillPayment = (method: Method | "credit") => {
    if (!shown) return;
    const empty = { cash: "", upi: "", card: "", bank: "" };
    update({ payments: method === "credit" ? empty : { ...empty, [method]: paiseToRupeeInput(shown.totals.totalPaise) }, ...(method === "cash" ? {} : { cashReceived: "" }) });
  };

  const save = () => {
    // The ref stops a second click that lands before React re-renders with `saving` set. The server
    // is the real guard: the same Idempotency-Key replays the saved bill instead of saving again.
    if (!current || hasUnreadable || savingRef.current) return;
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
            ? t("billing.errorAlreadySaved")
            : (result.error ?? t("billing.errorNotSaved")),
        );
      } catch {
        setError(t("billing.errorOffline"));
      } finally {
        savingRef.current = false;
      }
    });
  };

  const stockText = (product: Product) => (product.stockQty === null ? t("billing.notCounted") : t("billing.inStock", { qty: product.stockQty, unit: product.baseUnit }));
  const customer = customers.find((candidate) => candidate.id === customerId);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(20rem,1fr)]">
      <section aria-label={t("billing.itemsLabel")} className="flex min-w-0 flex-col gap-4 rounded-2xl border border-border bg-card p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold text-foreground">{lines.length > 0 ? t("billing.itemsCount", { count: lines.length }) : t("billing.itemsLabel")}</h2>
          <Button type="button" variant="outline" size="touch" onClick={resetBill} disabled={saving}>
            <FilePlus2 aria-hidden="true" />
            {t("billing.newBill")}
          </Button>
        </div>
        <div className="relative">
          <label data-guide="bill-search" className="relative block">
            <span className="sr-only">{t("billing.searchProducts")}</span>
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("billing.searchPlaceholder")} className="h-12 pl-9 text-base" autoComplete="off" />
          </label>
          {query.trim().length >= 2 && results.length > 0 ? (
            <ul role="listbox" aria-label={t("billing.matchingProducts")} className="absolute inset-x-0 top-full z-20 mt-1 max-h-80 overflow-y-auto rounded-xl border border-border bg-card shadow-lg">
              {results.map((product) => (
                <li key={product.id}>
                  <button type="button" role="option" aria-selected="false" onClick={() => addProduct(product)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-muted">
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-foreground">{product.name}</span>
                      <span className="block text-xs text-muted-foreground">{product.sku}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{stockText(product)}</span>
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
                <p className="font-semibold text-foreground">{t("billing.addProductFirst")}</p>
                <p className="max-w-sm text-sm text-muted-foreground">
                  {t(firstRun.canAddProducts ? "billing.addProductHelp" : "billing.askOwnerProducts")}
                </p>
                {firstRun.canAddProducts ? (
                  <Link href="/inventory/new" className={buttonVariants({ size: "touch" })}>
                    {t("billing.addFirstProduct")}
                  </Link>
                ) : null}
              </>
            ) : (
              <>
                <p className="font-semibold text-foreground">{t("billing.noItems")}</p>
                <p className="text-sm text-muted-foreground">{t("billing.noItemsHelp")}</p>
              </>
            )}
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {lines.map((line, index) => {
              const priced = shown?.lines[index]?.productId === line.product.id ? shown.lines[index] : undefined;
              const problem = lineProblem(index);
              return (
                <li key={line.key} data-guide="bill-line" className="flex flex-col gap-2 py-3 first:pt-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-foreground">{line.product.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {line.product.sku} · {stockText(line.product)}
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
                      <Button type="button" variant="ghost" size="touch" aria-label={t("billing.oneLess", { name: line.product.name })} onClick={() => setLine(line.key, { quantity: bump(line.quantity, -1) })}>
                        <Minus aria-hidden="true" />
                      </Button>
                      <Input
                        value={line.quantity}
                        onChange={(event) => setLine(line.key, { quantity: event.target.value })}
                        inputMode="decimal"
                        aria-label={t("billing.quantityOf", { name: line.product.name })}
                        aria-invalid={problem ? true : undefined}
                        className="h-11 w-20 border-0 text-center tabular-nums"
                      />
                      <Button type="button" variant="ghost" size="touch" aria-label={t("billing.oneMore", { name: line.product.name })} onClick={() => setLine(line.key, { quantity: bump(line.quantity, 1) })}>
                        <Plus aria-hidden="true" />
                      </Button>
                    </div>
                    <select aria-label={t("billing.unitFor", { name: line.product.name })} value={line.unit} onChange={(event) => setLine(line.key, { unit: event.target.value })} className={cn(selectClass, "w-auto min-w-28")}>
                      {line.product.units.map((unit) => (
                        <option key={unit.code} value={unit.code}>
                          {unit.label}
                        </option>
                      ))}
                    </select>
                    {priced ? <Badge variant="info">{priced.rateReason}</Badge> : null}
                    {priced && priced.unit !== priced.baseUnit ? <span className="text-xs text-muted-foreground">= {priced.baseQuantity} {priced.baseUnit}</span> : null}
                    <Button type="button" variant="ghost" size="touch" className="ml-auto" aria-label={t("billing.remove", { name: line.product.name })} onClick={() => setLines((all) => all.filter((candidate) => candidate.key !== line.key))}>
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

      <section aria-label={t("billing.summary")} className="flex flex-col gap-4 self-start rounded-2xl border border-border bg-card p-4 sm:p-5 lg:sticky lg:top-20">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("common.customer.label")} className="col-span-2" error={customerProblem?.message}>
            <select data-guide="bill-customer" value={customerId} onChange={(event) => update({ customerId: event.target.value })} className={selectClass}>
              <option value="">{t("common.walkInCustomer")}</option>
              {customers.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name} ({option.type === "wholesale" ? t("common.wholesale") : option.type === "retail" ? t("common.retail") : option.type}){option.area ? ` · ${option.area}` : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("billing.priceList")}>
            <select value={priceList} onChange={(event) => update({ priceList: event.target.value })} className={selectClass}>
              <option value="">{t(customer?.type === "wholesale" ? "billing.wholesaleAuto" : "billing.retailAuto")}</option>
              <option value="retail">{t("common.retail")}</option>
              <option value="wholesale">{t("common.wholesale")}</option>
            </select>
          </Field>
          <Field label={t("billing.billDiscount")} error={problems.find((problem) => problem.field === "discountPercent")?.message ?? fieldErrors.discountPercent}>
            <Input value={discountPercent} onChange={(event) => update({ discountPercent: event.target.value })} inputMode="decimal" placeholder="0" className="h-11 tabular-nums" />
          </Field>
          {bill?.interStateSales || placeOfSupply ? (
            <Field label={t("billing.placeOfSupply")} error={problems.find((problem) => problem.field === "placeOfSupply")?.message}>
              <select value={placeOfSupply} onChange={(event) => update({ placeOfSupply: event.target.value })} className={selectClass}>
                <option value="">{t("billing.ownState")}</option>
                {GST_STATE_LIST
                  .filter(([code]) => code !== bill?.shopStateCode)
                  .map(([code]) => (
                    <option key={code} value={code}>
                      {t("billing.deliveredTo", { state: stateName(t, code) })}
                    </option>
                  ))}
              </select>
            </Field>
          ) : null}
        </div>

        <dl data-guide="bill-totals" data-guide-synced={current ? "" : undefined} className="flex flex-col gap-1.5 border-t border-border pt-3 text-sm">
          {shown ? (
            <>
              <Row label={t("common.subtotal")} paise={shown.totals.subtotalPaise} />
              {shown.totals.discountPaise > 0 ? <Row help="discount" label={t("common.discount")} paise={-shown.totals.discountPaise} /> : null}
              <Row label={t("common.taxableValue")} paise={shown.totals.taxablePaise} />
              {shown.taxMode === "intra" ? (
                <>
                  <Row label="CGST" paise={shown.totals.cgstPaise} />
                  <Row label={stateTaxLabel(shown.shopStateCode)} paise={shown.totals.sgstPaise} />
                </>
              ) : null}
              {shown.taxMode === "inter" ? <Row label="IGST" paise={shown.totals.igstPaise} /> : null}
              {shown.taxMode === "none" ? <p className="text-xs text-muted-foreground">{t("billing.noGstCharged")}</p> : null}
              {shown.totals.roundOffPaise !== 0 ? <Row label={t("common.roundOff")} paise={shown.totals.roundOffPaise} /> : null}
              <div className="mt-1 flex items-baseline justify-between border-t border-border pt-2">
                <dt className="font-semibold text-foreground">{t("common.total")}</dt>
                <dd className="text-2xl font-bold text-foreground">
                  <Money paise={shown.totals.totalPaise} />
                </dd>
              </div>
            </>
          ) : (
            <p className="text-muted-foreground">{t(lines.length === 0 ? "billing.addItemsTotal" : previewing ? "billing.workingOut" : "billing.checkItems")}</p>
          )}
        </dl>

        <fieldset data-guide="bill-payment" className="flex flex-col gap-2 border-t border-border pt-3" disabled={lines.length === 0}>
          <legend className="text-sm font-semibold text-foreground">{t("billing.paymentNow")}</legend>
          <div className="flex flex-wrap gap-2">
            {METHODS.slice(0, 2).map((method) => (
              <Button key={method.key} type="button" variant="outline" size="sm" onClick={() => fillPayment(method.key)} disabled={!shown}>
                {t(method.key === "cash" ? "billing.allCash" : "billing.allUpi")}
              </Button>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => fillPayment("credit")} disabled={!customerId || !shown}>
              {t("billing.allCredit")}
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {METHODS.map((method) => (
              <Field key={method.key} label={t("billing.methodAmount", { method: t(method.label) })} error={unreadable[method.key] ? t(unreadable[method.key]!) : undefined}>
                <Input data-guide={`bill-pay-${method.key}`} aria-invalid={unreadable[method.key] ? true : undefined} value={payments[method.key]} onChange={(event) => setPayment(method.key, event.target.value)} inputMode="decimal" placeholder="0" className="h-11 tabular-nums" />
              </Field>
            ))}
          </div>
          {payments.cash ? (
            <Field
              label={t("billing.cashReceived")}
              hint={t("billing.cashReceivedHint")}
              error={unreadable.cashReceived ? t(unreadable.cashReceived) : cashShort ? t("billing.cashShort", { amount: formatPaise(cash!.shortPaise) }) : problems.find((problem) => problem.field === "cashReceived")?.message}
            >
              <Input data-guide="bill-cash-received" aria-invalid={unreadable.cashReceived ? true : undefined} value={cashReceived} onChange={(event) => update({ cashReceived: event.target.value })} inputMode="decimal" placeholder={payments.cash} className="h-11 tabular-nums" />
            </Field>
          ) : null}
          {shown ? (
            <div className="flex flex-col gap-1 text-sm">
              <Row help="partialPayment" label={t("billing.paidNow")} paise={shown.paidNowPaise} />
              <Row help="creditSale" label={t("billing.onCredit")} paise={shown.creditPaise} />
              {cash && !cashShort ? <Row label={t("billing.change")} paise={cash.changePaise} strong /> : null}
              {shown.balanceAfterPaise !== null ? <Row label={t("billing.outstandingAfter")} paise={shown.balanceAfterPaise} /> : null}
            </div>
          ) : null}
        </fieldset>

        {bannerProblems.length > 0 || error ? (
          <div role="alert" className="flex flex-col gap-1 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">
            {error ? (
              <p className="flex gap-2">
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                {error}
              </p>
            ) : null}
            {bannerProblems
              .filter((problem) => problem.message !== error)
              .map((problem) => (
                <p key={problem.code}>{problem.message}</p>
              ))}
          </div>
        ) : null}

        <Button data-guide="bill-save" type="button" size="touch" className="h-12 text-base" disabled={!canSave} onClick={save}>
          {saving ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
          {t(shown ? "billing.saveBillTotal" : "billing.saveBill")}
          {shown ? <Money paise={shown.totals.totalPaise} /> : null}
        </Button>
        <p className="text-xs text-muted-foreground">{t("billing.recheckNote")}</p>
      </section>
    </div>
  );
}

function Row({ label, paise, strong = false, help }: { label: string; paise: number; strong?: boolean; help?: HelpTopic }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="flex items-center gap-1 text-muted-foreground">{label}{help ? <HelpHint topic={help} /> : null}</dt>
      <dd className={strong ? "font-semibold text-foreground" : "text-foreground"}>
        <Money paise={paise} withPaise />
      </dd>
    </div>
  );
}
