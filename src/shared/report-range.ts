/**
 * Report date ranges (business dates in India time, inclusive). Pure: the caller passes today's date.
 * A bad or future custom range falls back to today with a message, never an error page.
 */
export const RANGE_PRESETS = ["today", "yesterday", "7d", "month", "custom"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export type ReportRange = { preset: RangePreset; from: string; to: string; days: number; label: string; problem: string | null };

/** Longest custom range, so one request never scans years of bills. */
export const MAX_RANGE_DAYS = 366;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function addDays(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

const validDate = (value: string | undefined): value is string => !!value && DATE.test(value) && addDays(value, 0) === value;

export function resolveRange(input: { range?: string; from?: string; to?: string }, today: string): ReportRange {
  const make = (preset: RangePreset, from: string, to: string, label: string, problem: string | null = null): ReportRange => ({ preset, from, to, days: daysBetween(from, to), label, problem });
  switch (input.range) {
    case "yesterday":
      return make("yesterday", addDays(today, -1), addDays(today, -1), "Yesterday");
    case "7d":
      return make("7d", addDays(today, -6), today, "Last 7 days");
    case "month":
      return make("month", `${today.slice(0, 8)}01`, today, "This month");
    case "custom": {
      const { from, to } = input;
      if (!validDate(from) || !validDate(to)) return make("today", today, today, "Today", "Choose both dates for a custom range.");
      if (from > to) return make("today", today, today, "Today", "The start date must be on or before the end date.");
      if (to > today) return make("today", today, today, "Today", "The range can't end in the future.");
      if (daysBetween(from, to) > MAX_RANGE_DAYS) return make("today", today, today, "Today", `Choose at most ${MAX_RANGE_DAYS} days.`);
      return make("custom", from, to, from === to ? from : `${from} to ${to}`);
    }
    default:
      return make("today", today, today, "Today");
  }
}

/** Query string for links that keep the chosen range. */
export function rangeQuery(range: Pick<ReportRange, "preset" | "from" | "to">): string {
  return range.preset === "custom" ? `range=custom&from=${range.from}&to=${range.to}` : `range=${range.preset}`;
}
