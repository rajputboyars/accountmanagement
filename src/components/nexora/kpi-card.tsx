import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { cn } from "cn";

type KpiCardProps = {
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  footer?: React.ReactNode;
  href?: string;
  className?: string;
};

/** A large headline number with its label. When `href` is set the whole card opens the underlying records. */
export function KpiCard({ label, value, detail, footer, href, className }: KpiCardProps) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-muted-foreground">{label}</span>
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

  return href ? (
    <Link href={href} className={classes}>
      {body}
    </Link>
  ) : (
    <div className={classes}>{body}</div>
  );
}
