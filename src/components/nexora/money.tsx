import { cn } from "cn";
import { formatPaise, type Paise } from "@/shared/money";

/** Displays an amount held in integer paise. Formatting only; never calculates. */
export function Money({
  paise,
  withPaise = false,
  className,
}: {
  paise: Paise;
  withPaise?: boolean;
  className?: string;
}) {
  return <span className={cn("tabular-nums", className)}>{formatPaise(paise, { withPaise })}</span>;
}
