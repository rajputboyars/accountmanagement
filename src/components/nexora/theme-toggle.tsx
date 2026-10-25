"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import { applyTheme, readTheme, subscribeTheme, type Theme } from "@/lib/theme";

const serverTheme = (): Theme => "light";

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, serverTheme);
  const next: Theme = theme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      onClick={() => applyTheme(next)}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      className="grid size-11 place-items-center rounded-full border border-border bg-card text-foreground transition-colors hover:bg-muted md:size-10"
    >
      {theme === "dark" ? <Sun className="size-[18px]" aria-hidden="true" /> : <Moon className="size-[18px]" aria-hidden="true" />}
    </button>
  );
}
