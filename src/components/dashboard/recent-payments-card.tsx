import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/nexora/money";
import { SectionCard } from "@/components/nexora/section-card";
import type { DemoPayment } from "@/demo/dashboard-data";

export function RecentPaymentsCard({ payments }: { payments: readonly DemoPayment[] }) {
  return (
    <SectionCard title="Recent payments" description="Money received today, including old dues">
      <ul className="flex flex-col divide-y divide-border">
        {payments.map((payment) => (
          <li key={`${payment.time}-${payment.customer}`} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="truncate text-sm font-medium text-foreground">{payment.customer}</span>
              <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <Badge variant="neutral">{payment.method}</Badge>
                {payment.time} · {payment.against}
              </span>
            </div>
            <Money paise={payment.amountPaise} className="shrink-0 text-sm font-semibold text-foreground" />
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
