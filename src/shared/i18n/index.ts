import { en, type MessageKey, type Messages } from "./messages/en";
import { hi } from "./messages/hi";
import { hinglish } from "./messages/hinglish";
import { DEFAULT_LANGUAGE, type Language } from "./languages";
import { interpolate, makeTranslate, type Translate } from "./translate";

export { DEFAULT_LANGUAGE, isLanguage, LANGUAGE_LOCALES, LANGUAGE_NAMES, LANGUAGES, normalizeLanguage, type Language } from "./languages";
export { interpolate, isMessageKey, makeTranslate, splitMessage, type MessageVars, type Translate } from "./translate";
export type { MessageKey, Messages } from "./messages/en";

/** Server side only: this imports all three dictionaries. Client components get theirs from <LanguageProvider>. */
export const DICTIONARIES: Record<Language, Messages> = { en, hinglish, hi };

export function translatorFor(language: Language): Translate {
  return makeTranslate(DICTIONARIES[language] ?? DICTIONARIES[DEFAULT_LANGUAGE]);
}

type Pattern = { key: MessageKey; names: string[]; regex: RegExp };
let patterns: Pattern[] | undefined;

/** Longest first, so a specific message wins over a shorter one that also matches. */
function serverMessagePatterns(): Pattern[] {
  patterns ??= (Object.keys(en) as MessageKey[])
    .filter((key) => key.startsWith("server."))
    .sort((a, b) => en[b].length - en[a].length)
    .map((key) => {
      const names: string[] = [];
      const source = en[key].replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{(\w+)\}/g, (_, name: string) => {
        names.push(name);
        // An amount has a fixed shape, so a name just before it ("You owe {name} {amount}") keeps all its words.
        return name === "amount" ? "(-?₹[\\d,.]+)" : "(.+?)";
      });
      return { key, names, regex: new RegExp(`^${source}$`, "s") };
    });
  return patterns;
}

const METHOD_KEYS: Record<string, MessageKey> = { CASH: "common.cash", UPI: "common.upi", CARD: "common.card", BANK: "common.bank", CHEQUE: "common.cheque" };

/** Inside a server message only a payment method or unit code is ours to translate; every other value stays as written. */
function messageValue(name: string, value: string, language: Language): string {
  if (name === "method" && Object.hasOwn(METHOD_KEYS, value)) return DICTIONARIES[language][METHOD_KEYS[value]!];
  if (name === "approvalAction" || name === "otherAction") {
    const action = (Object.keys(en) as MessageKey[]).find((key) => key.startsWith("approvals.action.") && en[key] === value);
    return action ? DICTIONARIES[language][action] : value;
  }
  if (name === "saleUnit" || name === "unitName") {
    const unit = (Object.keys(en) as MessageKey[]).find((key) => /^unit\.\w+\.name$/.test(key) && en[key].toLowerCase() === value.toLowerCase());
    return unit ? DICTIONARIES[language][unit] : value;
  }
  if (name === "importType") {
    const type = (Object.keys(en) as MessageKey[]).find((key) => key.startsWith("import.type.") && en[key] === value);
    return type ? DICTIONARIES[language][type] : value;
  }
  if (name === "message") return translateServerMessage(value, language);
  const unitKey = `unit.${value}.short`;
  if ((name === "unit" || name === "base") && unitKey in en) return DICTIONARIES[language][unitKey as MessageKey];
  return value;
}

/**
 * Translates a message the server wrote in English (a business error, validation message or saved alert)
 * by matching it against the `server.*` entries. Values inside it, such as product names, are kept as
 * written. A message with no entry stays in English, so nothing is ever lost.
 */
export function translateServerMessage(message: string, language: Language): string {
  if (language === DEFAULT_LANGUAGE) return message;
  for (const { key, names, regex } of serverMessagePatterns()) {
    const match = regex.exec(message);
    if (match) return interpolate(DICTIONARIES[language][key], Object.fromEntries(names.map((name, index) => [name, messageValue(name, match[index + 1]!, language)])));
  }
  return message;
}
