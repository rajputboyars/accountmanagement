import { en, type MessageKey, type Messages } from "./messages/en";

export type MessageVars = Record<string, string | number>;
export type Translate = (key: MessageKey, vars?: MessageVars) => string;

/** Fills `{name}` placeholders. A placeholder with no value is left visible rather than hidden. */
export function interpolate(text: string, vars?: MessageVars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (vars[name] === undefined || vars[name] === null ? whole : String(vars[name])));
}

/** For keys built at runtime from data: check first, and show the record's own label when there is no entry. */
export function isMessageKey(key: string): key is MessageKey {
  return Object.hasOwn(en, key);
}

/** A missing or empty entry falls back to English, then to the key itself: the screen is never blank. */
export function makeTranslate(messages: Messages): Translate {
  return (key, vars) => interpolate(messages[key] || en[key] || key, vars);
}

/**
 * Splits a message around one placeholder, for wrapping that part in a link or <strong> while the whole sentence
 * stays one translated entry: `const [before, after] = splitMessage(t("key"), "link")`.
 */
export function splitMessage(text: string, name: string): [string, string] {
  const marker = `{${name}}`;
  const at = text.indexOf(marker);
  return at === -1 ? [text, ""] : [text.slice(0, at), text.slice(at + marker.length)];
}
