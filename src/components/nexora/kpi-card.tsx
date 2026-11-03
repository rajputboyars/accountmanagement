import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { cn } from "cn";
import { HelpHint } from "@/components/nexora/help-hint";
import type { HelpTopic } from "@/shared/i18n/help";

type KpiCardProps = {
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  footer?: React.ReactNode;
  href?: string;
  className?: string;
  /** Puts an information button beside the label, outside the card's link. */
  help?: HelpTopic;
};

/** A large headline number with its label. When `href` is set the whole card opens the underlying records. */
export function KpiCard({ label, value, detail, footer, href, className, help }: KpiCardProps) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className={cn("text-sm font-medium text-muted-foreground", help && "pr-6")}>{label}</span>
        {href ? (
          <ArrowUpRight
            className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        ) : null}
      </div>
      <div className="text-[28px] leading-tight font-bold tracking-tight text-foreground tabular-nums">{value}</div>
      {detail ? <div className="text-sm text-muted-foreground">{detail}</div> : null}
      {footer ? <div className="mt-auto pt-1">{footer}</div> : null}
    </>
  );

  const classes = cn(
    "group flex min-w-0 flex-col gap-2 rounded-2xl border border-border bg-card p-5 shadow-[0_1px_2px_rgba(20,36,58,0.04)]",
    href && "transition-[border-color,box-shadow] hover:border-teal/50 hover:shadow-md",
    className,
  );

  const card = href ? (
    <Link href={href} className={cn(classes, help && "h-full")}>
      {body}
    </Link>
  ) : (
    <div className={cn(classes, help && "h-full")}>{body}</div>
  );

  return help ? (
    <div className="relative min-w-0">
      {card}
      <HelpHint topic={help} className={cn("absolute top-5 text-muted-foreground", href ? "right-11" : "right-5")} />
    </div>
  ) : (
    card
  );
}
