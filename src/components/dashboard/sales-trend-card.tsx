import { cn } from "cn";
import { SectionCard } from "@/components/nexora/section-card";
import { formatPaise, formatPaiseCompact, type Paise } from "@/shared/money";

type TrendDay = { day: string; date: string; salesPaise: Paise; isToday: boolean };

export function SalesTrendCard({ days }: { days: readonly TrendDay[] }) {
  const max = Math.max(...days.map((day) => day.salesPaise));
  const today = days.find((day) => day.isToday);

  return (
    <SectionCard title="Sales, last 7 days" description="Bills made each day, including GST" className="xl:col-span-2">
      <div className="flex flex-col gap-3">
        <div
          role="img"
          aria-label={`Daily sales for the last 7 days. Today ${today ? formatPaise(today.salesPaise) : ""}, the highest of the week.`}
          className="flex h-52 items-end gap-2 border-b border-border sm:gap-4"
        >
          {days.map((day) => (
            <div key={day.date} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5">
              <span
                className={cn(
                  "text-xs font-semibold tabular-nums",
                  day.isToday ? "text-teal-strong" : "text-muted-foreground max-sm:hidden",
                )}
              >
                {formatPaiseCompact(day.salesPaise)}
              </span>
              <div
                title={`${day.day} ${day.date}: ${formatPaise(day.salesPaise)}`}
                className={cn("w-full max-w-12 rounded-t-lg", day.isToday ? "bg-teal" : "bg-chart-1/85 dark:bg-chart-1/60")}
                style={{ height: `${Math.max(4, (day.salesPaise / max) * 82)}%` }}
              />
            </div>
          ))}
        </div>
        <div className="flex gap-2 sm:gap-4">
          {days.map((day) => (
            <span
              key={day.date}
              className={cn("flex-1 text-center text-xs", day.isToday ? "font-semibold text-foreground" : "text-muted-foreground")}
            >
              {day.isToday ? "Today" : day.day}
            </span>
          ))}
        </div>
        <ul className="sr-only">
          {days.map((day) => (
            <li key={day.date}>
              {day.day} {day.date}: {formatPaise(day.salesPaise)}
            </li>
          ))}
        </ul>
      </div>
    </SectionCard>
  );
}
