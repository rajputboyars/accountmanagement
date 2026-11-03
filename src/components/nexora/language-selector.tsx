"use client";

import { useOptimistic, useState, useTransition } from "react";
import { Languages } from "lucide-react";
import { cn } from "cn";
import { setLanguageAction } from "@/app/(app)/language-actions";
import { LANGUAGE_NAMES, LANGUAGES, isLanguage } from "@/shared/i18n/languages";
import { useLanguage, useT } from "./language-provider";

/** "sidebar" is an icon on the tablet rail and a labelled menu on desktop; "sheet" is always labelled. */
export function LanguageSelector({ variant }: { variant: "sidebar" | "sheet" }) {
  const t = useT();
  const language = useLanguage();
  const [shown, setShown] = useOptimistic(language);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const change = (value: string) => {
    if (!isLanguage(value)) return;
    setError(null);
    startTransition(async () => {
      setShown(value);
      const result = await setLanguageAction(value);
      if (!result.ok) setError(result.error);
    });
  };

  return (
    <div className="flex flex-col gap-1">
      <label className={cn("relative flex items-center gap-2 text-xs font-medium text-sidebar-foreground", variant === "sidebar" && "justify-center xl:justify-start")}>
        <Languages className="size-5 shrink-0" aria-hidden="true" />
        <span className={cn(variant === "sidebar" && "sr-only xl:not-sr-only xl:shrink-0")}>{t("language.label")}</span>
        <select
          value={shown}
          disabled={pending}
          onChange={(event) => change(event.target.value)}
          className={cn(
            "h-11 min-w-0 flex-1 rounded-lg border border-input bg-background px-2 text-sm text-foreground disabled:opacity-60",
            // On the icon rail the menu covers the icon, so the icon is what opens it.
            variant === "sidebar" && "absolute inset-0 opacity-0 xl:static xl:opacity-100",
          )}
        >
          {LANGUAGES.map((option) => (
            <option key={option} value={option}>
              {LANGUAGE_NAMES[option]}
            </option>
          ))}
        </select>
      </label>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
