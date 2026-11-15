"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { LoaderCircle, Plus, X } from "lucide-react";
import { searchProductsAction } from "@/app/(app)/billing/actions";
import { createOrderAction } from "@/app/(app)/billing/orders/actions";
import { Field, FormAlert, selectClass } from "@/components/catalog/form-bits";
import { useT } from "@/components/nexora/language-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Product = Awaited<ReturnType<typeof searchProductsAction>>["products"][number];
type Line = { key: number; product: Product | null; unit: string; quantity: string };
let nextKey = 1;
const blank = (): Line => ({ key: nextKey++, product: null, unit: "", quantity: "" });

/** An optional order: who it is for, what and how much, and when. Stock is only set aside if it is confirmed. */
export function OrderForm({ customers, godowns }: { customers: { id: string; name: string }[]; godowns?: { id: string; name: string }[] }) {
  const t = useT();
  const router = useRouter();
  const [customerId, setCustomerId] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [notes, setNotes] = useState("");
  const [godownId, setGodownId] = useState("");
  const [lines, setLines] = useState<Line[]>(() => [blank()]);
  const [query, setQuery] = useState<Record<number, string>>({});
  const [results, setResults] = useState<Record<number, Product[]>>({});
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const update = (key: number, changes: Partial<Line>) => setLines((all) => all.map((line) => (line.key === key ? { ...line, ...changes } : line)));

  // Search the product list as the person types in a line's search box.
  useEffect(() => {
    const active = Object.entries(query).filter(([, text]) => text.trim().length >= 2);
    const timer = setTimeout(async () => {
      for (const [key, text] of active) {
        const found = await searchProductsAction(text);
        setResults((all) => ({ ...all, [Number(key)]: found.products }));
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const submit = (confirm: boolean) =>
    start(async () => {
      const result = await createOrderAction({
        idempotencyKey,
        customerId,
        expectedDate,
        notes,
        confirm,
        ...(godowns && godownId ? { godownId } : {}),
        lines: lines.filter((line) => line.product).map((line) => ({ productId: line.product!.id, unit: line.unit || line.product!.baseUnit, quantity: line.quantity })),
      });
      if (result.ok && result.id) {
        router.push(`/billing/orders/${result.id}`);
        return;
      }
      setError(result.error);
      setFieldErrors(result.fieldErrors ?? {});
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("orders.customer")} error={fieldErrors.customerId}>
          <select value={customerId} onChange={(event) => setCustomerId(event.target.value)} className={selectClass}>
            <option value="">{t("orders.chooseCustomer")}</option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("orders.expected")} error={fieldErrors.expectedDate}>
          <Input type="date" value={expectedDate} onChange={(event) => setExpectedDate(event.target.value)} className="h-11" />
        </Field>
      </div>
      <ul className="flex flex-col gap-3">
        {lines.map((line, index) => (
          <li key={line.key} className="flex flex-col gap-3 rounded-xl border border-border p-3">
            {line.product ? (
              <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
                <div className="flex flex-col justify-center text-sm">
                  <span className="font-medium text-foreground">{line.product.name}</span>
                  <span className="text-xs text-muted-foreground">{line.product.sku}</span>
                </div>
                <Field label={t("orders.qty")} error={fieldErrors[`lines.${index}.quantity`]}>
                  <Input value={line.quantity} onChange={(event) => update(line.key, { quantity: event.target.value })} inputMode="decimal" className="h-11 tabular-nums" />
                </Field>
                <Field label={t("orders.unit")} error={fieldErrors[`lines.${index}.unit`]}>
                  <select value={line.unit || line.product.baseUnit} onChange={(event) => update(line.key, { unit: event.target.value })} className={selectClass}>
                    {line.product.units.map((unit) => (
                      <option key={unit.code} value={unit.code}>
                        {unit.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Button type="button" variant="ghost" size="icon" className="size-11 self-end" aria-label={t("godown.transfer.remove")} onClick={() => setLines((all) => (all.length > 1 ? all.filter((candidate) => candidate.key !== line.key) : [blank()]))}>
                  <X aria-hidden="true" />
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <Field label={t("orders.item")} error={fieldErrors[`lines.${index}.productId`]}>
                  <Input value={query[line.key] ?? ""} onChange={(event) => setQuery((all) => ({ ...all, [line.key]: event.target.value }))} placeholder={t("billing.searchPlaceholder")} className="h-11" />
                </Field>
                {(results[line.key] ?? []).length > 0 && (query[line.key] ?? "").trim().length >= 2 ? (
                  <ul className="flex max-h-56 flex-col divide-y divide-border overflow-y-auto rounded-xl border border-border">
                    {results[line.key]!.map((product) => (
                      <li key={product.id}>
                        <button type="button" onClick={() => update(line.key, { product, unit: product.baseUnit })} className="flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted/50">
                          <span className="min-w-0 truncate">{product.name}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">{product.sku}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )}
          </li>
        ))}
      </ul>
      <Button type="button" variant="outline" size="touch" className="self-start" onClick={() => setLines((all) => [...all, blank()])}>
        <Plus aria-hidden="true" />
        {t("orders.addItem")}
      </Button>
      <Field label={t("orders.notes")} error={fieldErrors.notes}>
        <Input value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={300} className="h-11" />
      </Field>
      {godowns ? (
        <Field label={t("orders.setAside")} error={fieldErrors.godownId}>
          <select value={godownId} onChange={(event) => setGodownId(event.target.value)} className={selectClass}>
            <option value="">{t("godown.choose")}</option>
            {godowns.map((godown) => (
              <option key={godown.id} value={godown.id}>
                {godown.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <p className="text-xs text-muted-foreground">{t("orders.stockNote")}</p>
      <FormAlert error={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="touch" disabled={pending || !customerId || lines.every((line) => !line.product)} onClick={() => submit(true)}>
          {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
          {t("orders.saveConfirm")}
        </Button>
        <Button type="button" variant="outline" size="touch" disabled={pending || !customerId || lines.every((line) => !line.product)} onClick={() => submit(false)}>
          {t("orders.saveDraft")}
        </Button>
      </div>
    </div>
  );
}
