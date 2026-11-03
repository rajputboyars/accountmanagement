import Link from "next/link";
import { Clock } from "lucide-react";
import { splitMessage, type Translate } from "@/shared/i18n/translate";

/** Tells the owner how many requests are waiting. The count is bold; the sentence stays one translated entry. */
export function ApprovalNotice({ count, t }: { count: number; t: Translate }) {
  const [before, after] = splitMessage(t(count > 1 ? "dashboard.approvalsWaiting" : "dashboard.approvalWaiting"), "requests");
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-amber/40 bg-amber-soft px-4 py-3 text-sm text-amber-ink">
      <div className="flex items-center gap-2">
        <Clock className="size-4 shrink-0" aria-hidden="true" />
        <span>
          {before}
          <strong>{count > 1 ? t("dashboard.requests", { count }) : t("dashboard.request")}</strong>
          {after}
        </span>
      </div>
      <Link href="/approvals" className="inline-flex min-h-10 items-center font-semibold whitespace-nowrap text-teal-strong hover:underline">
        {t("dashboard.reviewInbox")}
      </Link>
    </div>
  );
}
