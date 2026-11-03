"use client";

import { useLanguage, useT } from "@/components/nexora/language-provider";
import { LANGUAGE_LOCALES, type Language } from "@/shared/i18n/languages";
import { formatPaise, formatPaiseCompact } from "@/shared/money";

type Point = { key: string; label: string; billedPaise: number; collectedPaise: number };

const shortLabel = (point: Point, by: "day" | "month", language: Language) =>
  by === "month"
    ? new Intl.DateTimeFormat(LANGUAGE_LOCALES[language].dates, { month: "short", timeZone: "UTC" }).format(new Date(`${point.key}-01T00:00:00Z`))
    : new Intl.DateTimeFormat(LANGUAGE_LOCALES[language].dates, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${point.key}T00:00:00Z`));

/** Billed sales next to money collected per day (or month). Two different things, drawn side by side. */
export function TrendChart({ points, by }: { points: Point[]; by: "day" | "month" }) {
  const t = useT();
  const language = useLanguage();
  const max = Math.max(1, ...points.map((point) => Math.max(point.billedPaise, point.collectedPaise)));
  const showEvery = Math.ceil(points.length / 10);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-chart-1" aria-hidden="true" /> {t("trend.billed")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-teal" aria-hidden="true" /> {t("trend.collected")}
        </span>
      </div>
      <div role="img" aria-label={t(by === "day" ? "trend.ariaDays" : "trend.ariaMonths", { count: points.length })} className="flex h-48 items-end gap-1 border-b border-border sm:gap-2">
        {points.map((point) => (
          <div key={point.key} className="flex h-full min-w-0 flex-1 items-end justify-center gap-0.5" title={t("trend.pointTitle", { period: shortLabel(point, by, language), billed: formatPaise(point.billedPaise), collected: formatPaise(point.collectedPaise) })}>
            <div className="w-full max-w-5 rounded-t bg-chart-1/85 dark:bg-chart-1/60" style={{ height: `${point.billedPaise ? Math.max(2, (point.billedPaise / max) * 100) : 0}%` }} />
            <div className="w-full max-w-5 rounded-t bg-teal" style={{ height: `${point.collectedPaise > 0 ? Math.max(2, (point.collectedPaise / max) * 100) : 0}%` }} />
          </div>
        ))}
      </div>
      <div className="flex gap-1 sm:gap-2" aria-hidden="true">
        {points.map((point, index) => (
          <span key={point.key} className="min-w-0 flex-1 truncate text-center text-[11px] text-muted-foreground">
            {index % showEvery === 0 ? shortLabel(point, by, language) : ""}
          </span>
        ))}
      </div>
      <p className="text-xs text-muted-foreground tabular-nums">{t("trend.highest", { amount: formatPaiseCompact(max) })}</p>
      <table className="sr-only">
        <thead>
          <tr>
            <th>{t("trend.period")}</th>
            <th>{t("trend.billed")}</th>
            <th>{t("trend.collected")}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.key}>
              <td>{point.key}</td>
              <td>{formatPaise(point.billedPaise)}</td>
              <td>{formatPaise(point.collectedPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
