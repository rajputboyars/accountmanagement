import { isMessageKey, type Translate } from "./translate";

/** Safe in client components. A category with no entry shows the record's own label instead of a blank. */
export function expenseLabel(t: Translate, row: { key: string; label: string }): string {
  const key = `expense.${row.key}`;
  return isMessageKey(key) ? t(key) : row.label;
}
