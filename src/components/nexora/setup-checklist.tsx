"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CircleCheck, Circle, X } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { formatPaise } from "@/shared/money";
import type { Onboarding, OnboardingStepKey } from "@/modules/reporting";

const STEP_TEXT: Record<OnboardingStepKey, { title: string; detail: string; action: string }> = {
  business: { title: "Add your shop's address and phone", detail: "They are printed on every bill.", action: "Open settings" },
  product: { title: "Add your first product", detail: "Name and selling price. You can add the rest later.", action: "Add a product" },
  stock: { title: "Enter how much stock you have", detail: "Count what is on the shelf (opening stock), so bills can check it.", action: "Enter stock" },
  bill: { title: "Make your first bill", detail: "Bill a walk-in customer, or pick a customer to give udhaar (credit).", action: "New bill" },
};

/** Today's figures for the "you're set up" card. Profit is null when the viewer can't see it. */
export type TodaySummary = {
  billedPaise: number;
  billCount: number;
  collectedPaise: number;
  receivablePaise: number | null;
  expensesPaise: number;
  profit: { reliable: true; grossProfitPaise: number } | { reliable: false } | null;
};

/** What the card shows: the steps until all are done, then today's summary (only on the today view). */
export function checklistMode(onboarding: Onboarding, today: TodaySummary | null): "steps" | "done" | "hidden" {
  if (!onboarding.complete) return "steps";
  return today ? "done" : "hidden";
}

/** The line under a step: done, what to do, or who can do it. */
export function stepHint(step: Onboarding["steps"][number]): string {
  return step.done ? "Done." : step.canAct ? STEP_TEXT[step.key].detail : "Ask the owner to do this.";
}

/**
 * First-run checklist on the dashboard. Progress comes from the server (real records), so this
 * component only remembers, on this device, that the person closed it.
 */
export function SetupChecklist({ shopId, onboarding, today }: { shopId: string; onboarding: Onboarding; today: TodaySummary | null }) {
  const storageKey = `nexora:setup-checklist:${shopId}:${onboarding.complete ? "done" : "steps"}`;
  const [hidden, setHidden] = useState<boolean | null>(null);
  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = window.localStorage.getItem(storageKey) === "1";
    } catch {
      // Storage blocked (private window): just show the card.
    }
    setHidden(dismissed); // eslint-disable-line react-hooks/set-state-in-effect -- read once after hydration
  }, [storageKey]);

  const mode = checklistMode(onboarding, today);
  if (hidden !== false || mode === "hidden") return null;
  const dismiss = () => {
    try {
      window.localStorage.setItem(storageKey, "1");
    } catch {
      // Not remembered on this device; it simply shows again next time.
    }
    setHidden(true);
  };
  const close = (
    <button type="button" onClick={dismiss} className="-m-2 grid size-11 shrink-0 place-items-center rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close">
      <X className="size-5" aria-hidden="true" />
    </button>
  );

  if (mode === "done" && today) {
    const profit = today.profit;
    const rows: { label: string; value: string; note?: string }[] = [
      { label: "Today's sales", value: formatPaise(today.billedPaise), note: `${today.billCount} ${today.billCount === 1 ? "bill" : "bills"}` },
      { label: "Payments received", value: formatPaise(today.collectedPaise) },
      ...(today.receivablePaise !== null ? [{ label: "Customers owe you (udhaar)", value: formatPaise(today.receivablePaise) }] : []),
      { label: "Expenses", value: formatPaise(today.expensesPaise) },
      ...(profit ? [profit.reliable ? { label: "Profit", value: formatPaise(profit.grossProfitPaise), note: "before GST" } : { label: "Profit", value: "Not available", note: "add cost prices" }] : []),
    ];
    return (
      <section aria-label="Setup done" className="flex flex-col gap-4 rounded-2xl border border-teal/40 bg-teal-soft p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="flex items-center gap-2 font-semibold text-foreground">
              <CircleCheck className="size-5 text-teal-strong" aria-hidden="true" />
              Your shop is set up
            </h2>
            <p className="text-sm text-muted-foreground">This dashboard is your daily summary. Check these five numbers at the end of each day:</p>
          </div>
          {close}
        </div>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {rows.map((row) => (
            <div key={row.label} className="flex flex-col gap-0.5 rounded-xl bg-card p-3">
              <dt className="text-xs text-muted-foreground">{row.label}</dt>
              <dd className="font-semibold text-foreground tabular-nums">{row.value}</dd>
              {row.note ? <dd className="text-xs text-muted-foreground">{row.note}</dd> : null}
            </div>
          ))}
        </dl>
      </section>
    );
  }

  const total = onboarding.steps.length;
  const next = onboarding.steps.find((step) => !step.done);
  return (
    <section aria-label="Set up your shop" className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-semibold text-foreground">Get your shop ready in {total} steps</h2>
          <p className="text-sm text-muted-foreground">
            {onboarding.doneCount} of {total} done. Each step ticks itself off when you finish it.
          </p>
        </div>
        {close}
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={onboarding.doneCount}>
        <div className="h-full rounded-full bg-teal transition-[width]" style={{ width: `${(onboarding.doneCount / total) * 100}%` }} />
      </div>
      <ol className="flex flex-col gap-3">
        {onboarding.steps.map((step) => {
          const text = STEP_TEXT[step.key];
          const isNext = step.key === next?.key;
          return (
            <li key={step.key} className="flex flex-col gap-3 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                {step.done ? <CircleCheck className="mt-0.5 size-5 shrink-0 text-teal-strong" aria-hidden="true" /> : <Circle className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />}
                <div className="flex flex-col">
                  <span className={step.done ? "font-medium text-muted-foreground line-through" : "font-medium text-foreground"}>
                    {text.title}
                    <span className="sr-only">{step.done ? " (done)" : " (to do)"}</span>
                  </span>
                  <span className="text-sm text-muted-foreground">{stepHint(step)}</span>
                </div>
              </div>
              {!step.done && step.canAct ? (
                <Link href={step.href} className={buttonVariants({ variant: isNext ? "default" : "outline", size: "touch" })}>
                  {text.action}
                </Link>
              ) : null}
            </li>
          );
        })}
      </ol>
      {onboarding.canImport ? (
        <p className="text-sm text-muted-foreground">
          Already have a list in Excel or another app?{" "}
          <Link href="/settings/setup#import" className="font-semibold text-teal-strong hover:underline">
            Import products, customers and suppliers from a spreadsheet
          </Link>
          . Every row is checked before anything is saved.
        </p>
      ) : null}
    </section>
  );
}
