"use client";

import { useActionState, useState } from "react";
import { closeDayAction, recordCashMovementAction, recordExpenseAction, reopenDayAction, voidExpenseAction, type CashFormState } from "@/app/(app)/cashbook/actions";
import { Field, FormAlert, FormSelect, SubmitButton } from "@/components/catalog/form-bits";
import { Money } from "@/components/nexora/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DIFFERENCE_REASONS, drawerResult, EXPENSE_CATEGORIES } from "@/shared/cashbook";
import { parseRupeesToPaise } from "@/shared/money";

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "") : `${Date.now()}${Math.random().toString(36).slice(2)}`);

/** A form that gets a fresh idempotency key and clears itself after each successful save. */
function useKeyedAction(action: (previous: CashFormState, formData: FormData) => Promise<CashFormState>) {
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);
  const [state, formAction] = useActionState<CashFormState, FormData>(async (previous, formData) => {
    const result = await action(previous, formData);
    if (result.ok) setIdempotencyKey(newKey());
    return result;
  }, {});
  return { idempotencyKey, state, formAction };
}

export function ExpenseForm({ date }: { date: string }) {
  const { idempotencyKey, state, formAction } = useKeyedAction(recordExpenseAction);
  const values = state.ok ? {} : (state.values ?? {});
  const errors = state.fieldErrors ?? {};
  return (
    <form key={idempotencyKey} action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="businessDate" value={date} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Category" error={errors.category}>
          <FormSelect name="category" defaultValue={values.category ?? "tea"}>
            {EXPENSE_CATEGORIES.map((category) => (
              <option key={category.key} value={category.key}>
                {category.label}
              </option>
            ))}
          </FormSelect>
        </Field>
        <Field label="Amount (₹)" error={errors.amount}>
          <Input name="amount" defaultValue={values.amount} inputMode="decimal" placeholder="e.g. 150" className="h-11 tabular-nums" />
        </Field>
        <Field label="Paid by" error={errors.method}>
          <FormSelect name="method" defaultValue={values.method ?? "cash"}>
            <option value="cash">Cash (from the drawer)</option>
            <option value="upi">UPI</option>
            <option value="bank">Bank</option>
          </FormSelect>
        </Field>
        <Field label={<span>Reference <span className="font-normal text-muted-foreground">(optional)</span></span>} error={errors.reference}>
          <Input name="reference" defaultValue={values.reference} maxLength={40} className="h-11" />
        </Field>
      </div>
      <Field label={<span>Note <span className="font-normal text-muted-foreground">(needed for Other)</span></span>} error={errors.note}>
        <Input name="note" defaultValue={values.note} maxLength={200} placeholder="e.g. Delivery auto to Vaishali Nagar" className="h-11" />
      </Field>
      <FormAlert error={state.fieldErrors ? undefined : state.error} message={state.message} />
      <div>
        <SubmitButton variant="outline">Add expense</SubmitButton>
      </div>
    </form>
  );
}

export function CashMovementForm({ date }: { date: string }) {
  const { idempotencyKey, state, formAction } = useKeyedAction(recordCashMovementAction);
  const values = state.ok ? {} : (state.values ?? {});
  const errors = state.fieldErrors ?? {};
  return (
    <form key={idempotencyKey} action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="businessDate" value={date} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="What happened" error={errors.kind}>
          <FormSelect name="kind" defaultValue={values.kind ?? "bank_deposit"}>
            <option value="bank_deposit">Deposited in bank</option>
            <option value="withdrawal">Owner took cash</option>
            <option value="float_added">Cash put in the drawer</option>
          </FormSelect>
        </Field>
        <Field label="Amount (₹)" error={errors.amount}>
          <Input name="amount" defaultValue={values.amount} inputMode="decimal" className="h-11 tabular-nums" />
        </Field>
      </div>
      <Field label={<span>Note <span className="font-normal text-muted-foreground">(optional)</span></span>} error={errors.note}>
        <Input name="note" defaultValue={values.note} maxLength={200} className="h-11" />
      </Field>
      <FormAlert error={state.fieldErrors ? undefined : state.error} message={state.message} />
      <div>
        <SubmitButton variant="outline">Record</SubmitButton>
      </div>
    </form>
  );
}

export function VoidExpense({ expenseId }: { expenseId: string }) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState<CashFormState, FormData>(voidExpenseAction, {});
  if (!open) {
    return (
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Void
      </Button>
    );
  }
  return (
    <form action={action} className="flex w-full flex-wrap items-end gap-2">
      <input type="hidden" name="expenseId" value={expenseId} />
      <Field label="Why void it?" error={state.error} className="flex-1">
        <Input name="reason" maxLength={200} className="h-11" />
      </Field>
      <SubmitButton variant="destructive">Void</SubmitButton>
      <Button type="button" variant="ghost" size="touch" onClick={() => setOpen(false)}>
        Keep
      </Button>
    </form>
  );
}

const LABEL = { matches: "Drawer matches", short: "Cash short", extra: "Cash extra" } as const;

/** Owner's day-end count. The difference shown here is only a preview; the server works it out again. */
export function CloseDayForm({ date, expectedPaise }: { date: string; expectedPaise: number }) {
  const [state, action] = useActionState<CashFormState, FormData>(closeDayAction, {});
  const [counted, setCounted] = useState(state.values?.counted ?? "");
  const [confirming, setConfirming] = useState(false);
  const countedPaise = parseRupeesToPaise(counted);
  const result = countedPaise === null ? null : drawerResult(expectedPaise, countedPaise);
  const errors = state.fieldErrors ?? {};
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="businessDate" value={date} />
      <Field label="Cash counted in the drawer (₹)" error={errors.counted}>
        <Input name="counted" value={counted} onChange={(event) => setCounted(event.target.value)} inputMode="decimal" placeholder="e.g. 18150" className="h-12 text-lg tabular-nums" />
      </Field>
      {result ? (
        <p className={`rounded-xl px-4 py-3 text-sm font-semibold ${result.label === "matches" ? "bg-success-soft text-success" : "bg-amber-soft text-amber-ink"}`}>
          {LABEL[result.label]}
          {result.differencePaise !== 0 ? (
            <>
              {" "}
              {result.differencePaise < 0 ? "−" : "+"}
              <Money paise={Math.abs(result.differencePaise)} withPaise />
            </>
          ) : null}
        </p>
      ) : null}
      {result && result.differencePaise !== 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Reason for the difference" error={errors.reasonKey}>
            <FormSelect name="reasonKey" defaultValue={state.values?.reasonKey ?? ""}>
              <option value="" disabled>
                Choose…
              </option>
              {DIFFERENCE_REASONS.map((reason) => (
                <option key={reason.key} value={reason.key}>
                  {reason.label}
                </option>
              ))}
            </FormSelect>
          </Field>
          <Field label={<span>Note <span className="font-normal text-muted-foreground">(needed for Other)</span></span>} error={errors.reasonNote}>
            <Input name="reasonNote" defaultValue={state.values?.reasonNote} maxLength={200} className="h-11" />
          </Field>
        </div>
      ) : null}
      <FormAlert error={state.fieldErrors ? undefined : state.error} message={state.message} />
      {confirming ? (
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-muted/50 p-3">
          <p className="text-sm text-foreground">Close the day? Bills, payments and expenses for this day are locked until you reopen it.</p>
          <div className="flex flex-wrap gap-2">
            <SubmitButton>Yes, close the day</SubmitButton>
            <Button type="button" variant="ghost" size="touch" onClick={() => setConfirming(false)}>
              Not yet
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" size="touch" className="self-start" disabled={!result} onClick={() => setConfirming(true)}>
          Close the day
        </Button>
      )}
    </form>
  );
}

export function ReopenDayForm({ date }: { date: string }) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState<CashFormState, FormData>(reopenDayAction, {});
  if (!open) {
    return (
      <Button type="button" variant="outline" size="touch" className="self-start" onClick={() => setOpen(true)}>
        Reopen the day
      </Button>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="businessDate" value={date} />
      <Field label="Why reopen it?" error={state.error}>
        <Input name="reason" maxLength={200} className="h-11" />
      </Field>
      <div className="flex flex-wrap gap-2">
        <SubmitButton variant="outline">Reopen</SubmitButton>
        <Button type="button" variant="ghost" size="touch" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
