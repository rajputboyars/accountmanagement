"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { LoaderCircle } from "lucide-react";
import { finalizeAction, type BankResult } from "@/app/(app)/reports/money/bank/actions";
import { Field, FormAlert } from "@/components/catalog/form-bits";
import { useT } from "@/components/nexora/language-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Step 1: which statement are you checking? The figures update when you press the button. */
export function ReconcileInputs({ today, min, date, balance }: { today: string; min: string; date: string; balance: string }) {
  const t = useT();
  return (
    <form method="get" className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("bank.rec.date")} hint={t("bank.rec.dateHint")}>
          <Input type="date" name="date" required min={min} max={today} defaultValue={date} className="h-11 sm:max-w-56" />
        </Field>
        <Field label={t("bank.rec.balance")} hint={t("bank.rec.balanceHint")}>
          <Input name="balance" required inputMode="decimal" defaultValue={balance} placeholder="0" className="h-11 tabular-nums" />
        </Field>
      </div>
      <Button type="submit" size="touch" className="self-start">
        {t("bank.rec.check")}
      </Button>
    </form>
  );
}

/** Step 2: finish it. Once finished, the figures are kept as they are and those days are closed to matching. */
export function FinishBox({ bankAccountId, date, balance, canFinish }: { bankAccountId: string; date: string; balance: string; canFinish: boolean }) {
  const t = useT();
  const router = useRouter();
  const key = useRef(crypto.randomUUID());
  const [note, setNote] = useState("");
  const [result, setResult] = useState<BankResult | null>(null);
  const [pending, start] = useTransition();
  const finish = () =>
    start(async () => {
      const outcome = await finalizeAction({ idempotencyKey: key.current, bankAccountId, statementDate: date, statementBalance: balance, note });
      setResult(outcome);
      if (outcome.ok) router.push(`/reports/money/bank/${bankAccountId}/reconcile`);
    });
  return (
    <div className="flex flex-col gap-3">
      <Field label={t("bank.rec.note")} hint={t("bank.rec.noteHint")}>
        <Input value={note} onChange={(event) => setNote(event.target.value)} maxLength={300} className="h-11" />
      </Field>
      <FormAlert error={result?.error} message={result?.ok ? result.message : undefined} />
      <Button type="button" size="touch" className="self-start" disabled={!canFinish || pending} onClick={finish}>
        {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
        {t("bank.rec.finish")}
      </Button>
      {!canFinish ? <p className="text-xs text-muted-foreground">{t("bank.rec.cannotFinish")}</p> : null}
    </div>
  );
}
