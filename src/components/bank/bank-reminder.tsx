"use client";

import Link from "next/link";
import { Landmark } from "lucide-react";
import { useT } from "@/components/nexora/language-provider";

/**
 * A gentle note that bank statement lines are waiting to be matched. It never blocks anything: closing the day does not depend on it.
 * One account with lines waiting links straight to that account; otherwise to the Bank screen.
 */
export function BankReminder({ summary, closing = false }: { summary: { total: number; accounts: { id: string; name: string; count: number }[] }; closing?: boolean }) {
  const t = useT();
  if (summary.total === 0) return null;
  const href = summary.accounts.length === 1 ? `/reports/money/bank/${summary.accounts[0]!.id}` : "/reports/money/bank";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-amber-soft px-4 py-3 text-sm text-amber-ink" data-testid="bank-reminder">
      <p className="flex min-w-0 items-start gap-2">
        <Landmark className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>
          {t("bank.reminder.text", { count: summary.total })}
          {closing ? <span className="block text-xs opacity-90">{t("bank.reminder.closeNote")}</span> : null}
        </span>
      </p>
      <Link href={href} className="inline-flex min-h-11 items-center font-semibold underline-offset-2 hover:underline">
        {t("bank.reminder.action")}
      </Link>
    </div>
  );
}
