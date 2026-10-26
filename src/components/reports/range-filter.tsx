import Link from "next/link";
import { cn } from "cn";
import { buttonVariants } from "@/components/ui/button";
import { rangeQuery, type RangePreset, type ReportRange } from "@/shared/report-range";

const PRESETS: { preset: Exclude<RangePreset, "custom">; label: string }[] = [
  { preset: "today", label: "Today" },
  { preset: "yesterday", label: "Yesterday" },
  { preset: "7d", label: "7 days" },
  { preset: "month", label: "This month" },
];

/** Date range pills plus a custom from–to form. Plain links and a GET form: the server reads the range. */
export function RangeFilter({ basePath, range, today }: { basePath: string; range: ReportRange; today: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <nav aria-label="Date range" className="flex flex-wrap gap-1 rounded-xl border border-border bg-card p-1">
          {PRESETS.map(({ preset, label }) => (
            <Link
              key={preset}
              href={`${basePath}?${rangeQuery({ preset, from: "", to: "" })}`}
              aria-current={range.preset === preset ? "page" : undefined}
              className={cn("inline-flex min-h-10 items-center rounded-lg px-3 text-sm font-medium", range.preset === preset ? "bg-teal-strong text-white" : "text-muted-foreground hover:bg-muted hover:text-foreground")}
            >
              {label}
            </Link>
          ))}
        </nav>
        <form action={basePath} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="range" value="custom" />
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            From
            <input type="date" name="from" required max={today} defaultValue={range.preset === "custom" ? range.from : ""} className="h-10 rounded-lg border border-input bg-background px-2 text-sm text-foreground" />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            To
            <input type="date" name="to" required max={today} defaultValue={range.preset === "custom" ? range.to : ""} className="h-10 rounded-lg border border-input bg-background px-2 text-sm text-foreground" />
          </label>
          <button type="submit" className={buttonVariants({ variant: range.preset === "custom" ? "default" : "outline", className: "h-10" })}>
            Apply
          </button>
        </form>
      </div>
      {range.problem ? (
        <p role="alert" className="text-sm text-danger">
          {range.problem} Showing today instead.
        </p>
      ) : null}
    </div>
  );
}
