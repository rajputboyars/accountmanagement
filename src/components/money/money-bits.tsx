import Link from "next/link";
import { CircleAlert, CircleCheck } from "lucide-react";
import type { Completeness } from "@/modules/accounting";
import type { MessageKey, Translate } from "@/shared/i18n";

/** An account's name in the reader's language; accounts are stored in English with a stable key. */
export function accountLabel(t: Translate, key: string, fallback: string): string {
  const messageKey = `money.account.${key}` as MessageKey;
  const label = t(messageKey);
  return label === messageKey ? fallback : label;
}

export function eventLabel(t: Translate, event: string): string {
  const reversed = event.startsWith("reversal:");
  const base = reversed ? event.slice("reversal:".length) : event;
  const messageKey = `money.acc.event.${base}` as MessageKey;
  const label = t(messageKey);
  const text = label === messageKey ? base : label;
  return reversed ? `${t("money.acc.reversal")}: ${text}` : text;
}

/** Complete, or why not, in plain words. Shown above every figure that rests on the books. */
export function CompletenessNote({ completeness, t, fixHref }: { completeness: Completeness; t: Translate; fixHref?: string }) {
  if (completeness.complete) {
    return (
      <p className="inline-flex items-center gap-2 self-start rounded-full bg-success-soft px-3 py-1 text-xs font-medium text-success">
        <CircleCheck className="size-3.5" aria-hidden="true" />
        {t("money.complete")}
      </p>
    );
  }
  return (
    <div role="status" className="flex flex-col gap-2 rounded-xl border border-amber/50 bg-muted/40 p-3 text-sm">
      <p className="inline-flex items-center gap-2 font-medium text-foreground">
        <CircleAlert className="size-4 text-amber" aria-hidden="true" />
        {t("money.incomplete")}
      </p>
      <ul className="list-disc pl-5 text-muted-foreground">
        {completeness.reasons.map((reason) => (
          <li key={reason}>{t(`money.reason.${reason}` as MessageKey)}</li>
        ))}
      </ul>
      {fixHref ? (
        <Link href={fixHref} className="self-start text-sm font-semibold text-teal-strong hover:underline">
          {t("money.fixIt")}
        </Link>
      ) : null}
    </div>
  );
}
