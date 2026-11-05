"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { LoaderCircle } from "lucide-react";
import { cancelChallanAction, cancelOrderAction, closeOrderAction, confirmOrderAction, deliverAction, reserveOrderAction } from "@/app/(app)/billing/orders/actions";
import { Field, FormAlert, selectClass } from "@/components/catalog/form-bits";
import { useT } from "@/components/nexora/language-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Godown = { id: string; name: string };

/** Confirm, set stock aside, close or cancel an order. Each is one action on the server; the page refreshes with the result. */
export function OrderControls({ orderId, status, godowns, canCreate }: { orderId: string; status: string; godowns?: Godown[]; canCreate: boolean }) {
  const t = useT();
  const router = useRouter();
  const [godownId, setGodownId] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  const run = (work: () => Promise<{ ok?: boolean; error?: string }>) =>
    start(async () => {
      const result = await work();
      if (result.ok) {
        setError(undefined);
        setReason("");
        router.refresh();
      } else setError(result.error);
    });
  if (!canCreate || status === "cancelled" || status === "delivered") return null;
  return (
    <div className="flex flex-col gap-3 print:hidden">
      {status === "draft" ? (
        <div className="flex flex-wrap items-end gap-2">
          {godowns ? (
            <Field label={t("orders.setAside")} className="min-w-48">
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
          <Button type="button" size="touch" disabled={pending || (Boolean(godowns) && !godownId)} onClick={() => run(() => confirmOrderAction(orderId, godownId || undefined))}>
            {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
            {t("orders.confirm")}
          </Button>
        </div>
      ) : (
        <Button type="button" variant="outline" size="touch" className="self-start" disabled={pending} onClick={() => run(() => reserveOrderAction(orderId))}>
          {t("orders.reserve")}
        </Button>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t("orders.reason")} className="min-w-48 flex-1">
          <Input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={200} className="h-11" />
        </Field>
        {status === "partially_delivered" ? (
          <Button type="button" variant="outline" size="touch" disabled={pending || reason.trim().length < 3} onClick={() => run(() => closeOrderAction(orderId, reason))}>
            {t("orders.close")}
          </Button>
        ) : (
          <Button type="button" variant="outline" size="touch" disabled={pending || reason.trim().length < 3} onClick={() => run(() => cancelOrderAction(orderId, reason))}>
            {t("orders.cancel")}
          </Button>
        )}
      </div>
      {status === "partially_delivered" ? <p className="text-xs text-muted-foreground">{t("orders.closeHelp")}</p> : null}
      <FormAlert error={error} />
    </div>
  );
}

type PendingLine = { id: string; productName: string; unit: string; pendingQty: string };

/** Deliver part or all of what is still pending. The dispatch godown is asked only when the shop has several. */
export function DeliverForm({ orderId, lines, godowns }: { orderId: string; lines: PendingLine[]; godowns?: Godown[] }) {
  const t = useT();
  const router = useRouter();
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [godownId, setGodownId] = useState("");
  const [note, setNote] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const picked = lines.filter((line) => (quantities[line.id] ?? "").trim() !== "");
  const submit = () =>
    start(async () => {
      const result = await deliverAction({ idempotencyKey, orderId, note, ...(godowns && godownId ? { godownId } : {}), lines: picked.map((line) => ({ orderLineId: line.id, quantity: quantities[line.id]!.trim() })) });
      if (result.ok) {
        setError(undefined);
        setFieldErrors({});
        setQuantities({});
        setMessage(result.message);
        setIdempotencyKey(crypto.randomUUID());
        router.refresh();
      } else {
        setMessage(undefined);
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
      }
    });
  return (
    <div className="flex flex-col gap-3 print:hidden">
      <ul className="flex flex-col gap-3">
        {lines.map((line, index) => (
          <li key={line.id} className="grid gap-3 rounded-xl border border-border p-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="flex flex-col justify-center text-sm">
              <span className="font-medium text-foreground">{line.productName}</span>
              <span className="text-xs text-muted-foreground">
                {t("orders.col.pending")}: {line.pendingQty} {line.unit}
              </span>
            </div>
            <Field label={`${t("orders.deliver.now")} (${line.unit})`} error={fieldErrors[`lines.${index}.quantity`]}>
              <Input value={quantities[line.id] ?? ""} onChange={(event) => setQuantities((all) => ({ ...all, [line.id]: event.target.value }))} inputMode="decimal" className="h-11 tabular-nums" />
            </Field>
          </li>
        ))}
      </ul>
      {godowns ? (
        <Field label={t("orders.deliver.godown")} error={fieldErrors.godownId}>
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
      <Field label={t("orders.deliver.note")}>
        <Input value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} className="h-11" />
      </Field>
      <FormAlert error={error} message={message} />
      <Button type="button" size="touch" className="self-start" disabled={pending || picked.length === 0 || (Boolean(godowns) && !godownId)} onClick={submit}>
        {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
        {t("orders.deliver.save")}
      </Button>
    </div>
  );
}

/** Cancels an unbilled delivery: the stock goes back to the godown it left. */
export function CancelChallanButton({ challanId, orderId }: { challanId: string; orderId: string }) {
  const t = useT();
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        {t("orders.challan.cancel")}
      </Button>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <Field label={t("orders.reason")}>
        <Input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={200} className="h-11" />
      </Field>
      <FormAlert error={error} />
      <Button
        type="button"
        variant="outline"
        size="touch"
        className="self-start"
        disabled={pending || reason.trim().length < 3}
        onClick={() =>
          start(async () => {
            const result = await cancelChallanAction(challanId, orderId, reason);
            if (result.ok) router.refresh();
            else setError(result.error);
          })
        }
      >
        {t("orders.challan.cancel")}
      </Button>
    </div>
  );
}
