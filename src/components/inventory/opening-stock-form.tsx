"use client";

import Link from "next/link";
import { startTransition, useActionState, useState } from "react";
import { CircleCheck, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { recordOpeningAction, type OpeningFormState } from "@/app/(app)/inventory/stock/actions";
import { Field, FormAlert, selectClass } from "@/components/catalog/form-bits";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatQuantity, parseQuantity, toBaseQuantity } from "@/shared/quantity";

export type OpeningProduct = {
  id: string;
  name: string;
  sku: string;
  baseUnit: string;
  units: { code: string; label: string; factor: string }[];
};

type Line = { rowId: number; productId: string; unit: string; quantity: string; unitCost: string };

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "") : `${Date.now()}${Math.random().toString(36).slice(2)}`);

/** "= 150 pc" preview using the shared exact-decimal helper; the server converts again and decides. */
function basePreview(product: OpeningProduct | undefined, unit: string, quantity: string): string | null {
  if (!product || !quantity.trim()) return null;
  const factor = product.units.find((candidate) => candidate.code === unit)?.factor;
  if (!factor) return null;
  try {
    const base = toBaseQuantity(parseQuantity(quantity), parseQuantity(factor));
    return base === null ? null : `${formatQuantity(base)} ${product.baseUnit}`;
  } catch {
    return null;
  }
}

export function OpeningStockForm({ products, canEnterCost, today }: { products: OpeningProduct[]; canEnterCost: boolean; today: string }) {
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);
  const [lines, setLines] = useState<Line[]>([{ rowId: 1, productId: "", unit: "", quantity: "", unitCost: "" }]);
  const [movementDate, setMovementDate] = useState(today);
  const [note, setNote] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [state, action, pending] = useActionState<OpeningFormState, FormData>(async (previous, formData) => {
    const result = await recordOpeningAction(previous, formData);
    if (!result.result) setReviewing(false);
    return result;
  }, {});
  const byId = new Map(products.map((product) => [product.id, product]));
  const errors = state.fieldErrors ?? {};

  if (state.result) {
    return (
      <div className="flex flex-col gap-4">
        <p role="status" className="flex gap-2 rounded-xl bg-success-soft px-4 py-3 text-sm text-success">
          <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          Opening stock saved for {state.result.lines.length} {state.result.lines.length === 1 ? "product" : "products"}
          {state.result.replayed ? " (this was already saved; nothing was added twice)" : ""}.
        </p>
        <ul className="flex flex-col divide-y divide-border text-sm">
          {state.result.lines.map((line) => (
            <li key={line.productId} className="flex justify-between gap-3 py-2">
              <span>{line.name}</span>
              <span className="font-semibold tabular-nums">
                {line.qty} {line.baseUnit}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Link href="/inventory/stock" className={buttonVariants({ size: "touch" })}>
            Go to stock
          </Link>
          <Link href="/inventory/stock/opening" className={buttonVariants({ size: "touch", variant: "outline" })} onClick={() => setIdempotencyKey(newKey())}>
            Enter more
          </Link>
        </div>
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
        Every active product already has stock entries. Use a stock adjustment to correct a count.
      </p>
    );
  }

  const update = (rowId: number, patch: Partial<Line>) => setLines((current) => current.map((line) => (line.rowId === rowId ? { ...line, ...patch } : line)));
  const chosen = new Set(lines.map((line) => line.productId).filter(Boolean));
  const payload = JSON.stringify({
    idempotencyKey,
    movementDate,
    note,
    lines: lines.map(({ productId, unit, quantity, unitCost }) => ({ productId, unit, quantity, unitCost: canEnterCost ? unitCost : "" })),
  });

  const startReview = () => {
    const incomplete = lines.findIndex((line) => !line.productId || !line.unit || !line.quantity.trim());
    if (incomplete >= 0) {
      setLocalError(`Line ${incomplete + 1} needs a product, a unit and a quantity.`);
      return;
    }
    setLocalError(null);
    setReviewing(true);
  };

  return (
    // Submitted through a transition rather than <form action>, so React does not reset the
    // controlled fields after a refused save and the lines stay as typed.
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        startTransition(() => action(formData));
      }}
      className="flex flex-col gap-5"
    >
      <input type="hidden" name="payload" value={payload} />
      <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
        <Field label="Opening date" hint="The day your count was taken." error={errors.movementDate}>
          <Input type="date" value={movementDate} max={today} onChange={(event) => setMovementDate(event.target.value)} disabled={reviewing} className="h-11" />
        </Field>
        <Field label={<span>Note <span className="font-normal text-muted-foreground">(optional)</span></span>} error={errors.note}>
          <Input value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} placeholder="e.g. Count on 31 Oct evening" disabled={reviewing} className="h-11" />
        </Field>
      </div>

      <ol className="flex flex-col gap-3">
        {lines.map((line, index) => {
          const product = byId.get(line.productId);
          const preview = basePreview(product, line.unit, line.quantity);
          const lineError = (field: string) => errors[`lines.${index}.${field}`];
          return (
            <li key={line.rowId} className="grid gap-3 rounded-xl border border-border p-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-start">
              <Field label={`Product ${index + 1}`} error={lineError("productId")}>
                <select
                  value={line.productId}
                  disabled={reviewing}
                  aria-invalid={lineError("productId") ? true : undefined}
                  onChange={(event) => {
                    const next = byId.get(event.target.value);
                    update(line.rowId, { productId: event.target.value, unit: next?.baseUnit ?? "" });
                  }}
                  className={selectClass}
                >
                  <option value="">Choose…</option>
                  {products.map((option) => (
                    <option key={option.id} value={option.id} disabled={chosen.has(option.id) && option.id !== line.productId}>
                      {option.name} ({option.sku})
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Counted in" error={lineError("unit")}>
                <select value={line.unit} disabled={reviewing || !product} onChange={(event) => update(line.rowId, { unit: event.target.value })} className={selectClass}>
                  {product ? (
                    product.units.map((unit) => (
                      <option key={unit.code} value={unit.code}>
                        {unit.label}
                      </option>
                    ))
                  ) : (
                    <option value="">—</option>
                  )}
                </select>
              </Field>
              <Field label="Quantity" hint={preview ? `= ${preview}` : undefined} error={lineError("quantity")}>
                <Input value={line.quantity} onChange={(event) => update(line.rowId, { quantity: event.target.value })} inputMode="decimal" placeholder="e.g. 94" disabled={reviewing} aria-invalid={lineError("quantity") ? true : undefined} className="h-11 tabular-nums" />
              </Field>
              <div className="flex items-end gap-2 sm:pt-6">
                {canEnterCost ? (
                  <Field label={<span className="sm:sr-only">Cost per {product?.baseUnit ?? "unit"} (₹)</span>} error={lineError("unitCost")} className="flex-1 sm:w-28">
                    <Input value={line.unitCost} onChange={(event) => update(line.rowId, { unitCost: event.target.value })} inputMode="decimal" placeholder="Cost ₹" disabled={reviewing} className="h-11 tabular-nums" />
                  </Field>
                ) : null}
                {lines.length > 1 && !reviewing ? (
                  <Button type="button" variant="ghost" size="touch" onClick={() => setLines((current) => current.filter((candidate) => candidate.rowId !== line.rowId))} aria-label={`Remove line ${index + 1}`}>
                    <Trash2 aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {canEnterCost ? <p className="-mt-2 text-xs text-muted-foreground">Cost is per base unit at the opening date. Leave it empty to use the product&apos;s cost price.</p> : null}

      {!reviewing && lines.length < 200 ? (
        <Button
          type="button"
          variant="outline"
          size="touch"
          className="self-start"
          onClick={() => setLines((current) => [...current, { rowId: Math.max(...current.map((line) => line.rowId)) + 1, productId: "", unit: "", quantity: "", unitCost: "" }])}
        >
          <Plus aria-hidden="true" />
          Add another product
        </Button>
      ) : null}

      <FormAlert error={localError ?? state.error} />

      {reviewing ? (
        <div className="flex flex-col gap-3 rounded-xl bg-amber-soft p-4 text-sm text-amber-ink">
          <p className="font-semibold">Check before saving: opening stock can be entered only once per product.</p>
          <ul className="flex flex-col gap-1">
            {lines.map((line) => {
              const product = byId.get(line.productId);
              return (
                <li key={line.rowId}>
                  {product?.name}: {line.quantity} {line.unit}
                  {basePreview(product, line.unit, line.quantity) && line.unit !== product?.baseUnit ? ` (${basePreview(product, line.unit, line.quantity)})` : ""}
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="touch" disabled={pending}>
              {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
              Save opening stock
            </Button>
            <Button type="button" variant="ghost" size="touch" onClick={() => setReviewing(false)}>
              Go back and change
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" size="touch" className="self-start" onClick={startReview}>
          Review {lines.length} {lines.length === 1 ? "line" : "lines"}
        </Button>
      )}
    </form>
  );
}
