import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle2 } from "lucide-react";
import { SectionCard } from "@/components/nexora/section-card";
import { buttonVariants } from "@/components/ui/button";
import type { AttentionItem } from "@/modules/reporting";
import type { MessageKey, Translate } from "@/shared/i18n";
import { formatPaise } from "@/shared/money";

/**
 * The few things to act on now, biggest rupee impact first, each with one button. Amounts arrive as paise and are
 * formatted here; names stay as the person wrote them.
 */
export function NeedsAttention({ items, t }: { items: AttentionItem[]; t: Translate }) {
  const words = (item: AttentionItem) => {
    const params = Object.fromEntries(Object.entries(item.params).map(([key, value]) => [key, key === "amount" && typeof value === "number" ? formatPaise(value, { withPaise: false }) : value]));
    return {
      title: t(`attention.${item.kind}.title` as MessageKey, params),
      detail: t(`attention.${item.kind}.detail` as MessageKey, params),
      action: t(`attention.${item.kind}.action` as MessageKey, params),
    };
  };
  return (
    <SectionCard title={t("attention.title")} flush>
      {items.length === 0 ? (
        <p data-testid="attention-empty" className="flex items-center gap-2 px-5 pb-4 text-sm text-muted-foreground">
          <CheckCircle2 className="size-4 text-success" aria-hidden="true" />
          {t("attention.empty")}
        </p>
      ) : (
        <ul data-testid="needs-attention" className="flex flex-col divide-y divide-border">
          {items.map((item) => {
            const text = words(item);
            return (
              <li key={item.id} data-attention={item.kind} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="flex min-w-0 items-start gap-3">
                  <AlertTriangle className={`mt-0.5 size-4 shrink-0 ${item.urgency === 3 ? "text-danger" : "text-amber-ink"}`} aria-hidden="true" />
                  <div className="min-w-0">
                    <p className="font-semibold text-foreground">{text.title}</p>
                    <p className="text-sm text-muted-foreground">{text.detail}</p>
                  </div>
                </div>
                <Link href={item.href} className={buttonVariants({ size: "touch", variant: item.urgency === 3 ? "default" : "outline" })}>
                  {text.action}
                  <ArrowRight aria-hidden="true" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}
