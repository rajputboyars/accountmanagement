"use client";

import { cn } from "cn";
import { useT } from "./language-provider";

export function LogoMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("grid size-10 shrink-0 place-items-center rounded-xl bg-navy shadow-sm", className)}
    >
      <span className="size-3.5 rounded-[5px] bg-teal shadow-[7px_7px_0_-2px_var(--amber)]" />
    </span>
  );
}

export function Logo({ showWordmark = true, className }: { showWordmark?: boolean; className?: string }) {
  const t = useT();
  return (
    <span className={cn("flex items-center gap-3", className)}>
      <LogoMark />
      {showWordmark ? (
        <span className="flex flex-col leading-tight">
          <span className="text-base font-bold tracking-tight text-foreground">Nexora</span>
          <span className="text-xs text-muted-foreground">{t("shell.tagline")}</span>
        </span>
      ) : (
        <span className="sr-only">Nexora</span>
      )}
    </span>
  );
}
