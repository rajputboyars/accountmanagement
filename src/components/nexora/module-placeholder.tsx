import Link from "next/link";
import { CircleCheck, Construction } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import type { NavItem } from "@/config/navigation";

/** Initial state for a module that has a route but is not built yet: says so plainly and lists what is coming. */
export function ModulePlaceholder({ item, children }: { item: NavItem; children?: React.ReactNode }) {
  const Icon = item.icon;
  return (
    <section
      aria-labelledby={`${item.key}-placeholder-title`}
      className="grid gap-6 rounded-3xl border border-border bg-card p-6 shadow-[0_1px_2px_rgba(20,36,58,0.04)] sm:p-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]"
    >
      <div className="flex flex-col items-start gap-4">
        <span className="grid size-14 place-items-center rounded-2xl bg-teal-soft text-teal-strong">
          <Icon className="size-7" aria-hidden="true" />
        </span>
        <Badge variant="warning" className="h-6 gap-1.5 px-2.5">
          <Construction aria-hidden="true" />
          Not built yet
        </Badge>
        <h2 id={`${item.key}-placeholder-title`} className="text-2xl font-semibold tracking-tight text-foreground">
          {item.label} is coming in a later phase
        </h2>
        <p className="max-w-md text-muted-foreground">
          This page is a placeholder in the preview. Nothing here reads or saves business data yet.
        </p>
        <Link href="/dashboard" className={buttonVariants({ variant: "outline", size: "touch" })}>
          Back to dashboard
        </Link>
      </div>
      <div className="flex flex-col gap-4 rounded-2xl bg-muted/60 p-5 sm:p-6">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">What this screen will do</h3>
        <ul className="flex flex-col gap-3">
          {item.planned.map((feature) => (
            <li key={feature} className="flex items-start gap-3 text-sm text-foreground sm:text-base">
              <CircleCheck className="mt-0.5 size-5 shrink-0 text-teal-strong" aria-hidden="true" />
              <span>{feature}</span>
            </li>
          ))}
        </ul>
        {children}
      </div>
    </section>
  );
}
